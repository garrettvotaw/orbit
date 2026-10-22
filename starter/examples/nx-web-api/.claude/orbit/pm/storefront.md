# Storefront PM

## Coordinates

- Tracker project: Storefront
- Area: the web app and its API (`apps/web`, `apps/api`, and the libs under `libs/`)
- Feature or epic to drive: Checkout rebuild
- Board columns, in order: New, Active, Pull Request, Done

## Domain traps

- Prices are integer cents everywhere. A decimal price in a DTO is a bug.
- The cart API is idempotent on `cartId`. A retry must reuse the same id, never mint a new one.
- Order status values are a closed set owned by the API. The web app never invents a status string.

## Consult triggers

- Requirements: the acceptance criteria are vague, or point at behaviour the story doesn't describe.
- Architect: the story touches more than one lib, or adds an endpoint and a screen together.
- UX: the story adds or changes a screen.
- Test data: the story needs a customer or an order in a specific state.

## On merge

Done

## Reference branches

- `main`: the base for every story.
- `release/checkout`: long-lived branch for the checkout rebuild. Target it only when the story says so.
