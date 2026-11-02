# Old/new A/B testing with GA4

BuyWise assigns the variant; Google Analytics measures outcomes. No Google
Optimize installation is needed. This follows Google's
[in-house/custom experiment guidance](https://developers.google.com/analytics/devguides/collection/ga4/integration#in-house_and_custom_experiments).

## What is being tested

| Variant | `ui_version` | Experience |
| --- | --- | --- |
| `a` | `old` | `HomeV1`, without shopping progress guidance |
| `b` | `new` | `HomeV2`, with shopping progress guidance on search/product pages |

This compares the existing UI variants in this repository, not two deployed git
revisions. Shared authentication, pricing and backend behavior remain shared.

In `ab` mode each browser has a random 50/50 assignment stored in local storage.
It persists across visits and sign-in, but not across browsers/devices or cleared
storage. This is browser-level randomization, not account-level randomization.
Unavailable storage excludes the browser from GA and shows the new version
(or the old version when explicitly configured as `v1`).

## Configure and deploy

Set these public build settings:

```dotenv
NEXT_PUBLIC_GA_MEASUREMENT_ID=G-YOUR_REAL_ID
NEXT_PUBLIC_HOMEPAGE_EXPERIMENT=ab
NEXT_PUBLIC_HOMEPAGE_EXPERIMENT_ID=homepage_v2_2026_11
NEXT_PUBLIC_GA_DEBUG=false
```

- Local Next.js: use `frontend/.env.local`, then restart `npm run dev`.
- Vercel: set the variables on the frontend project's Production environment and
  redeploy. The root backend `.env` is not loaded by the frontend on Vercel.
- Docker Compose: use root `.env`. Both development environment variables and
  production build arguments are wired. Rebuild the frontend for production.

`NEXT_PUBLIC_*` values are compiled into production JavaScript. Updating runtime
environment variables alone does not update an existing build. The measurement ID
comes from GA4 **Admin → Data streams → your Web stream**. Use the same property
and measurement ID for both variants; never put a GA API secret in frontend config.
Empty measurement ID disables GA. Product analytics providers have independent
settings and are unaffected by GA configuration.

Keep the experiment ID, split and experiences fixed during a test. For another
test, use a new ID in both variants (a short descriptive identifier, at most 64
characters); it creates a new assignment storage key and separates the results.
The historical fallback ID, when no ID is configured, is `homepage_v2_2026_10`.

## Configure the GA4 property

These settings must be made in the GA4 property; application code cannot create
them without access to that property.

1. In the Web stream, turn **Enhanced measurement off** for this implementation.
   BuyWise sends page views and funnel events itself. Automatic history page views
   can double-count navigation; automatic site-search/form/outbound events can
   collect raw queries or URLs outside BuyWise's curated events. Also avoid
   installing a second GA tag through GTM or a hosting integration.
2. Under **Admin → Custom definitions**, create these **Event** scoped dimensions:

   | Display name | Event parameter |
   | --- | --- |
   | Experiment ID | `experiment_id` |
   | Variant | `variant` |
   | UI version | `ui_version` |
   | Experiment mode | `experiment_mode` |

   Use `ui_version` for BuyWise's old/new labels. Google's built-in `app_version`
   refers to mobile app releases. If you already registered the other three
   dimensions, keep them; **Variant** alone is sufficient to compare `a` (old)
   and `b` (new). Registering **UI version** is optional for readable labels.
   After deploying this parameter rename, UI version is populated by new events;
   use Variant for historical comparisons too.

3. Optionally mark `retailer_clicked` as a key event. It means an outbound retailer
   click, not a completed purchase. `create_price_alert` and `save_product` are
   useful secondary outcomes; they fire after successful API responses.
4. Exclude your team's production visits using your GA internal-traffic setup.

Google documents [custom dimension setup and reporting delays](https://support.google.com/analytics/answer/14239696).
Allow 24–48 hours after registration and data collection for the dimensions to
appear in reports; use Realtime/DebugView for immediate verification.

## Events and exposure

Every manually tracked GA event carries `experiment_id`, `variant`, `ui_version`
and `experiment_mode`. The tag config also supplies that context to automatically
generated GA events. Callers cannot override the assigned cohort.

`experiment_exposure` fires once per browser document, after the assigned homepage
or search/product guidance state renders, only in `ab` mode. Direct entries to
search and product pages count because those pages also contain the treatment.
Reloading can produce another exposure event; use **users**, not raw exposure
event counts, as the experiment denominator. Visits to unrelated pages alone are
not exposure. A variant label on an event alone does not prove exposure.

Existing funnel events include:

| Event | Meaning |
| --- | --- |
| `experiment_exposure` | Visitor received the tested experience |
| `search_started` | Homepage search initiated |
| `search` | Search results returned, including result count/data mode |
| `view_product` | Product comparison page shown |
| `retailer_clicked` | Retailer offer clicked |
| `create_price_alert` | Price alert successfully created |
| `save_product` | Product successfully saved |

## Compare outcomes

In **Explore → Funnel exploration**, make a closed funnel with
`experiment_exposure` followed indirectly by `retailer_clicked`, and break it down
by **UI version** (or **Variant**). Filter to the exact **Experiment ID** and
**Experiment mode = ab**. Set a consistent conversion window before starting.
This prevents visits with no exposure from being treated as experimental users.
For a homepage-only analysis also restrict the exposure step to the homepage.

Use this primary metric:

```text
Retailer click conversion = exposed users who later click a retailer / exposed users
```

Create secondary funnels from exposure to `search_started`, `create_price_alert`
or `save_product`. A free-form table with variant rows, event-name columns and
Total users values helps check allocation and event coverage. Do not divide raw
click counts by users: one person may click several offers.

Choose the minimum worthwhile improvement and required sample size before
starting, and run through complete weekly cycles. GA's comparison tables alone
do not establish statistical significance. Check the observed split for major
imbalance, keep demo/live traffic comparable, and assess uncertainty before
declaring a winner. Do not include `v1`/`v2` rollout traffic in the randomized test.

## Verify before launch

1. Use a separate test GA4 property and set `NEXT_PUBLIC_GA_DEBUG=true`; restart or
   rebuild. Open a normal URL without `variant` and inspect **Admin → DebugView**.
2. Confirm exactly one `page_view` per navigation, one `experiment_exposure` per
   document after a tested screen renders, and identical experiment/variant labels
   on later search/product/click/alert events. Reload to confirm sticky assignment.
3. Verify both assignments using separate browser profiles or by clearing the
   `buywise:<experiment ID>` local-storage key between test runs. Random allocation
   can assign the same variant again; repeat as needed.
4. Visual preview links: `/?variant=a` (old), `/?variant=b` (new). Preview persists
   in that tab's session storage and suppresses GA. These links are for UI QA, not
   GA verification. Open `/?variant=reset` with a full navigation to leave preview.
   Use full navigations for these overrides; assignment is cached per document.
5. Inspect queued events in `window.dataLayer` and actual requests to
   `google-analytics.com/g/collect`. Query strings and URL fragments should not be
   in manually sent page locations. Check that preview and auth callback pages
   emit no custom GA events. Delivery also depends on network/ad-blocker settings.
6. Switch to the production ID and `NEXT_PUBLIC_GA_DEBUG=false`, redeploy, and
   confirm both variants arrive in Realtime. Never use preview links to recruit
   experimental traffic.

## End the experiment or roll back

Set `NEXT_PUBLIC_HOMEPAGE_EXPERIMENT=v2` to serve everyone the new experience, or
`v1` to serve everyone the old experience, then rebuild/redeploy. Neither mode
emits experiment exposure. Normal GA events retain their actual version and mode.
Keep the recorded experiment date range when analyzing results. To disable GA,
clear `NEXT_PUBLIC_GA_MEASUREMENT_ID` and rebuild.
