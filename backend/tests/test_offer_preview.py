"""Public comparisons show all eligible retailers except best/cheapest picks."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.core.config import get_settings
from app.models import Offer, Product, Retailer
from app.services.offer_service import OfferService


async def make_product(db, count=7):
    product = Product(name="Preview headphones", is_demo=True)
    db.add(product)
    await db.flush()
    retailers = []
    for i in range(count):
        retailer = Retailer(
            name=f"Preview Store {i}", slug=f"preview-{i}", domain=f"preview-{i}.in"
        )
        db.add(retailer)
        await db.flush()
        retailers.append(retailer)
        db.add(
            Offer(
                product_id=product.id,
                retailer_id=retailer.id,
                product_url=f"https://preview-{i}.in/item",
                listed_price=10000 + i * 100,
                estimated_final_price=10000 + i * 100,
                match_type="exact_match",
                match_confidence=1,
                availability="in_stock",
                condition="new",
                observed_at=datetime.now(timezone.utc),
                source_provider="test",
                is_demo=True,
            )
        )
    await db.commit()
    return product, retailers


@pytest.mark.asyncio
@pytest.mark.parametrize("prices_locked", [True, False])
async def test_preview_hides_only_selected_retailers_and_keeps_other_listings(
    client, db, auth_headers, admin_headers, monkeypatch, prices_locked
):
    monkeypatch.setattr(get_settings(), "PAYWALL_PRICES", prices_locked)
    product, retailers = await make_product(db)
    # Duplicate listings from a selected retailer stay locked. Price ties and
    # non-exact/unavailable offers from other retailers remain visible.
    for retailer, price, match, availability in [
        (retailers[0], 10001, "exact_match", "in_stock"),
        (retailers[5], 10000, "exact_match", "in_stock"),
        (retailers[6], 10002, "same_product_different_variant", "in_stock"),
        (retailers[6], 10003, "exact_match", "out_of_stock"),
    ]:
        db.add(
            Offer(
                product_id=product.id,
                retailer_id=retailer.id,
                product_url=f"https://{retailer.domain}/extra-{price}",
                listed_price=price,
                estimated_final_price=price,
                match_type=match,
                match_confidence=1,
                availability=availability,
                condition="new",
                observed_at=datetime.now(timezone.utc),
                source_provider="test",
                is_demo=True,
            )
        )
    await db.commit()
    url = f"/api/v1/products/{product.id}/offers"
    full = (await client.get(url, headers=admin_headers)).json()
    assert not full["locked"] and full["picks"] and full["locked_pick_categories"] == []
    picked_ids = {
        p["offer_id"] for p in full["picks"] if p["category"] in {"BEST_OVERALL", "CHEAPEST"}
    }
    protected = {o["retailer"]["id"] for o in full["offers"] if o["id"] in picked_ids}
    expected = {o["id"] for o in full["offers"] if o["retailer"]["id"] not in protected}
    bodies = []
    for headers in ({}, auth_headers):
        response = await client.get(url, headers=headers)
        assert response.status_code == 200
        body = response.json()
        bodies.append(body)
        assert body["locked"] and {o["id"] for o in body["offers"]} == expected
        assert body["picks"] == [] and body["lowest_final_price"] is None
        assert "CHEAPEST" in body["locked_pick_categories"]
        assert body["hidden_offers"] == full["total_offers"] - len(expected)
        assert len({o["retailer"]["id"] for o in body["offers"]}) >= 5
        for offer in body["offers"]:
            assert offer["retailer"]["id"] not in protected
        for offer in full["offers"]:
            if offer["retailer"]["id"] in protected:
                assert offer["retailer"]["id"] not in response.text
                assert offer["product_url"] not in response.text
    assert bodies[0] == bodies[1]
    # Other service consumers do not implicitly get preview access.
    restricted = await OfferService(db).compare(product.id, full=False, prices=False)
    assert restricted.offers == [] and restricted.lowest_final_price is None


@pytest.mark.asyncio
async def test_other_ranked_retailers_are_visible_without_a_two_store_cap(client, db, monkeypatch):
    product, retailers = await make_product(db)
    original_rank = OfferService.rank

    def distinct_picks(offers):
        ordered = sorted(offers, key=lambda offer: offer.price.estimated_final_price)
        template = original_rank(offers)[0]
        return [
            template.model_copy(
                update={
                    "category": category,
                    "offer_id": ordered[index].id,
                    "retailer_name": ordered[index].retailer.name,
                    "estimated_final_price": ordered[index].price.estimated_final_price,
                }
            )
            for category, index in [
                ("BEST_OVERALL", 1),
                ("CHEAPEST", 0),
                ("SAFEST", 2),
                ("BEST_VALUE", 3),
                ("FASTEST", 4),
            ]
        ]

    monkeypatch.setattr(OfferService, "rank", staticmethod(distinct_picks))
    response = await client.get(f"/api/v1/products/{product.id}/offers")
    assert response.status_code == 200
    body = response.json()
    assert {offer["retailer"]["id"] for offer in body["offers"]} == {
        str(retailer.id) for retailer in retailers[2:]
    }
    assert body["locked_pick_categories"] == ["BEST_OVERALL", "CHEAPEST"]
    assert body["hidden_offers"] == body["hidden_retailers"] == 2
    assert body["picks"] == [] and body["lowest_final_price"] is None
    for retailer in retailers[:2]:
        assert str(retailer.id) not in response.text
        assert retailer.domain not in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("count", [0, 1, 2])
async def test_sparse_catalogues_do_not_invent_preview_offers(client, db, count, monkeypatch):
    async def no_refresh(self, product):
        return {"providers": [], "warnings": []}

    monkeypatch.setattr(OfferService, "refresh_offers", no_refresh)
    product, _ = await make_product(db, count)
    body = (await client.get(f"/api/v1/products/{product.id}/offers")).json()
    assert body["total_offers"] == count
    assert len(body["offers"]) == (count if count <= 1 else count - 1)
    assert body["picks"] == [] and body["lowest_final_price"] is None
    assert body["hidden_offers"] == (1 if count > 1 else 0)
    assert body["locked"] is (count > 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("catalogue", ["tied_prices", "variants", "no_exact_matches"])
async def test_nine_retailers_never_become_an_empty_free_comparison(
    client, db, auth_headers, catalogue
):
    product, _ = await make_product(db, count=9)
    offers = (await db.execute(select(Offer).where(Offer.product_id == product.id))).scalars().all()
    for index, offer in enumerate(offers):
        if catalogue == "tied_prices":
            offer.listed_price = offer.estimated_final_price = 10000
        elif index > 0 or catalogue == "no_exact_matches":
            offer.match_type = "same_product_different_variant"
        if catalogue == "variants" and index == 7:
            offer.availability = "out_of_stock"
        if catalogue == "variants" and index == 8:
            offer.condition = "refurbished"
    await db.commit()
    for headers in ({}, auth_headers):
        response = await client.get(f"/api/v1/products/{product.id}/offers", headers=headers)
        assert response.status_code == 200
        body = response.json()
        assert body["total_offers"] == 9
        assert len({o["retailer"]["id"] for o in body["offers"]}) >= 7
        assert body["hidden_retailers"] <= 2
        assert len(body["offers"]) + body["hidden_offers"] == 9
        assert set(body["locked_pick_categories"]) <= {"BEST_OVERALL", "CHEAPEST"}
        if catalogue == "variants":
            assert any(o["match"]["match_type"] != "exact_match" for o in body["offers"])
            assert any(o["availability"] == "out_of_stock" for o in body["offers"])
            assert any(o["condition"] == "refurbished" for o in body["offers"])
        if catalogue == "no_exact_matches":
            assert len(body["offers"]) == 9 and not body["locked"]


@pytest.mark.asyncio
async def test_two_different_winners_still_leave_one_retailer_free(client, db, monkeypatch):
    product, _ = await make_product(db, count=2)
    original_rank = OfferService.rank

    def separate_winners(offers):
        ordered = sorted(offers, key=lambda o: o.price.estimated_final_price)
        template = original_rank(offers)[0]
        return [
            template.model_copy(update={"category": "BEST_OVERALL", "offer_id": ordered[1].id}),
            template.model_copy(update={"category": "CHEAPEST", "offer_id": ordered[0].id}),
        ]

    monkeypatch.setattr(OfferService, "rank", staticmethod(separate_winners))
    body = (await client.get(f"/api/v1/products/{product.id}/offers")).json()
    assert len(body["offers"]) == 1
    assert body["hidden_retailers"] == body["hidden_offers"] == 1
    assert body["locked_pick_categories"] == ["BEST_OVERALL"]
