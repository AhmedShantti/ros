# Organisation bounded context

Phase 15. Authoritative decisions: [`../adr/0008-organisation-foundation.md`](../adr/0008-organisation-foundation.md).

## What exists

| Aggregate | Table | Tenant anchor |
|---|---|---|
| Brand | `org.brands` | direct `tenant_id` |
| Branch | `org.branches` | direct `tenant_id` |
| Warehouse | `org.warehouses` | direct `tenant_id` |
| Central Kitchen | `org.central_kitchens` | direct `tenant_id` |
| Station | `org.stations` | via `branch_id` |
| Table | `org.tables` | via `branch_id` |
| Operating Hours | `org.operating_hours` | via `branch_id` |
| Print Routing | `org.print_routing` | via `branch_id` |
| Station Routing Rule | `kitchen.station_routing_rules` | via `branch_id` |

## What is deliberately absent

Each of these is a ratified decision, not an oversight:

- **`org.tables.status`** — live table state is order-driven and owned by Sales (D-05).
- **Delete / deactivate endpoints** — none, for any entity (D-12).
- **Branch groups**, **`org.settings`**, **`org.locations`** — deferred (D-10, D-11, D-14).
- **Branch-scoped RBAC** — deferred; authorization is tenant-scoped (D-02).
- **Station routing *resolution*** (FR-KDS-010) — Kitchen Ops behaviour; only configuration is stored (D-06).
- **Print routing priority / active flag** — defined by neither the SRS nor the approved SQL.
- **Station display colour, branch country pack, seat count / floor area, aggregate `version`** — required or implied by the SRS but with no column in the approved SQL; not invented.

## Docs

`architecture.md` · `domain-model.md` · `authorization.md` · `rls.md` · `security-review.md`
