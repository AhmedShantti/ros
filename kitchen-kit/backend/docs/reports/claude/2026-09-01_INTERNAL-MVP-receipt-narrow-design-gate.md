# INTERNAL MVP RECEIPT — Narrow Design + Governance Gate

| Field | Value |
|---|---|
| **Task / slice name** | INTERNAL-MVP RECEIPT — narrow, non-fiscal, itemized receipt: implementation-ready design + governance gate |
| **Report type** | Analysis / design / governance gate. **No implementation.** No source change, no migration, no schema change, no route, no permission, no governance edit, no OpenAPI regeneration, no test execution, no commit, no push, no deploy. |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the **only** authorities. This report records what was verified **in this session** against the repository at the HEAD below. It ratifies nothing and creates no scope. `ROS_MVP_READINESS_AND_REMAINING_WORK.pdf` is an audit artefact, **not** an authority (see §21.3). |
| **Date** | 2026-09-01 |
| **HEAD** | `1cc9ace9fe4d8ddda69d65475899a2f4a9fb7930` — *fix: tighten OpenAPI response contracts* |
| **Parent chain (verified)** | `803aa3d` → `02fd05a` → `7bc5d2c` → `38e007b` → `121b889` |
| **Branch** | `feat/production-spec` |
| **Working tree** | Dirty **only** in `docs/reports/claude/`: modified `INDEX.md` + four untracked pre-existing reports. **Zero** source / schema / migration / test / OpenAPI drift. Verified by `git status --porcelain`. |
| **Task identifier** | INTERNAL-MVP-receipt-narrow-design-gate |
| **Status** | COMPLETE |
| **Migrations** | 35 — unchanged. **None created. None required** (§16). Verified by directory count of `prisma/migrations/`. |
| **API surface** | 111 paths / **151 operations** in `docs/api/openapi.json` — counted this session, matches the stated baseline. |
| **Tests** | **NO test suite was executed in this session.** Every test file referenced below is cited as **structural source evidence only**. The baseline figures quoted in the task prompt (unit 797, boundaries 45, e2e 1134/63 suites, migrations 35) are **restated as the user's declared baseline**, not as results produced here. Two figures were independently confirmed by static counting: migrations = 35, `module-boundaries.spec.ts` `it(` count = 45. |

---

## §0. VERDICT

> # **A. RECEIPT DESIGN ACCEPTED-READY — IMPLEMENTATION CAN START**
>
> **No STOP condition fired.** Every §27 stop condition was tested against
> current source and each is answered NO:
>
> | Stop condition | Result | Evidence |
> |---|---|---|
> | Completed orders do not retain stable historical line names/details | **NO** | `order_lines.item_name_snapshot` + `order_line_modifiers.name_snapshot`, both `JSONB`, both written at capture and never rewritten (§H) |
> | Finalized prices/tax cannot be reconstructed without mutable Catalogue | **NO** | Every money field is a persisted `BigInt` minor-unit column on the line/order row (§G, §H) |
> | Payment/tender facts unavailable through a legal module boundary | **NO** | `sales.order_payments` is a **Sales-owned** table in the **Sales** schema (§I, §N) |
> | A new persistent receipt/fiscal identity is actually required | **NO** | The document reference is the existing `orders.order_number` (§K) |
> | SRS makes a legal/fiscal receipt mandatory for the Internal-MVP exit | **NO** | FR-POS-100 is [M] for the **product**; the Internal-MVP exit gate is a **user-owned sequencing decision**, and the user has ratified the carve-out (§A, §T, §U) |
> | A new DB migration is required | **NO** | §P — MIGRATION REQUIRED: **NO** |
> | A new Fiscal subsystem is required | **NO** | §T — P1C-1's four named exclusions are each untouched |
> | Resolving receipt requires reopening D-2 | **NO** | §F — tenant-scoped permission reuse, zero branch-scoped RBAC |
> | Unresolved correctness defect in completed-order facts | **NO** | §H.6 — the Σ-lines ≡ totals invariant is structurally provable |
>
> **Not B** — historical stability is **proven from schema + capture code**, not asserted (§H).
> **Not C** — the designed slice has **ZERO cross-module dependencies** (§N).
> **Not D** — P1C-1 creates **no tax document, no invoice template, no fiscal submission and no `fiscal.tax_rules` table**; it is not reopened, not amended, not narrowed (§T).
> **Not E** — no table, no column, no sequence, no migration (§P).
> **Not F** — HEAD, parent chain, migration count and operation count were each re-verified against the repository this session.
>
> **Two documentation defects were found in the PRE-EXISTING order contract** (§Q.4).
> They are **out of this slice's scope**, are **not** fixed here, and the receipt
> schema is designed **not to repeat them**.

---

## §1. WHAT THIS REPORT IS AND IS NOT

This is a design and governance gate. It changes nothing. Its output is a
specification precise enough that an implementation run can execute it without
re-deciding anything, plus the one governance entry the user's ratification
needs recorded against.

It does **not** declare Internal MVP complete (§W, §X).

---

## §A. SRS RECEIPT REQUIREMENT TABLE

### A.1 Source search performed

`ROS_SRS_v1.0.pdf` was extracted with `pdftotext -layout` (6,510 lines) and
searched for every term the task named: `receipt`, `receipts`, `invoice`,
`fiscal`, `print`, `reprint`, `customer receipt`, `tax invoice`, and
`FR-POS-100` … `FR-POS-106`. Requirement text below is quoted from the
extracted source at the line numbers given, **not** from memory or from any
prior report.

**The complete receipt requirement set in the SRS is §8.8 "Receipts and
Documents", SRS lines 2383–2399.** No other FR in the document imposes a
customer-receipt obligation. `FR-LOC-022` — cited by the readiness audit
alongside FR-POS-100 — was read in full (SRS line 4902) and is about
**cryptographic signing of country packs**, not receipt content; it is
therefore **not** a receipt requirement and is excluded from this table.

### A.2 The table

| Requirement | Exact obligation (SRS verbatim, abridged only where marked …) | Marker | Current status at `1cc9ace` | Covered by the narrow Internal-MVP receipt? | Status AFTER the slice | Still deferred to Fiscal / Country-Pack phase? |
|---|---|---|---|---|---|---|
| **FR-POS-100** | "The System SHALL **print** a customer receipt containing **all elements mandated by the branch's country pack**, including **tax registration number**, **invoice sequence**, **tax breakdown**, and **any required QR code**." | **[M]** | **NOT IMPLEMENTED** — zero receipt/document/print code in `src/` | **PARTIALLY.** An itemized customer-receipt **document body** becomes retrievable. **None** of the four named mandated elements is delivered, and **no printing** is delivered. | **PARTIAL** | **YES** — TRN, invoice sequence, tax breakdown, QR, country-pack element set, and physical printing all remain deferred |
| **FR-POS-101** | "Receipt layout SHALL be **template-driven per country pack and per brand**, supporting **logo**, custom **header/footer** text, and **language selection**." | **[M]** | NOT IMPLEMENTED | **NO** — template engine, logo, header/footer and layout selection are all explicit §4 exclusions | **NOT IMPLEMENTED** (unchanged) | **YES** |
| **FR-POS-102** | "The System SHALL support **bilingual receipts with configurable layout**: Arabic only, English only, or both with defined ordering." | **[M]** | NOT IMPLEMENTED | **NO.** The response returns the persisted **locale→name** snapshot maps verbatim, so a bilingual render is *possible at the client*; the requirement's substance — **server-side configurable layout and ordering** — is untouched. | **NOT IMPLEMENTED** (unchanged; enabling substrate noted, not claimed) | **YES** |
| **FR-POS-103** | "The System SHALL support **digital receipt delivery by SMS, WhatsApp, email, and QR code**, in addition to or instead of printing." | **[M]** | NOT IMPLEMENTED | **NO** — every delivery channel is an explicit §4 exclusion; no customer contact is collected anywhere | **NOT IMPLEMENTED** (unchanged) | **YES** |
| **FR-POS-104** | "The System SHALL support **receipt reprint**, with reprints **clearly marked as duplicates** and **logged**." | **[S]** | NOT IMPLEMENTED | **NO.** Re-`GET` returns a byte-identical document, which satisfies the **Internal-MVP** reprint need (§15 of the task, §L below) — but it delivers **neither** duplicate marking **nor** a reprint log, which are the requirement's two substantive limbs. `pos.reprint.receipt` (SRS §15.2, line 3606) is deliberately **NOT** adopted (§F). | **NOT IMPLEMENTED** (unchanged) | **YES** |
| **FR-POS-105** | "**Kitchen tickets** SHALL print in the **kitchen's configured language**, which may differ from the customer receipt language." | **[M]** | NOT IMPLEMENTED — KDS is a **display**; no kitchen printing exists | **NO** — out of scope; this is a KDS/printing requirement, unrelated to the customer receipt document | **NOT IMPLEMENTED** (unchanged) | **YES** (printing phase) |
| **FR-POS-106** | "The System SHALL handle **printer failure** gracefully: **queue** the job, **alert** the user, permit continuation of the sale, and **retry** automatically, never blocking the transaction." | **[M]** | NOT IMPLEMENTED | **NO** — spooler, queue, retry, printer health are explicit §4 exclusions; there is no printing subsystem to fail | **NOT IMPLEMENTED** (unchanged) | **YES** (printing phase) |

### A.3 The one classification that changes — and only that one

**FR-POS-100 moves NOT IMPLEMENTED → PARTIAL. Nothing else moves.**

That is the entire requirement-status consequence of this slice. Six of the
seven §8.8 requirements keep their existing classification verbatim.

**FR-POS-100 is PARTIAL, not COMPLETE, and the boundary is precise:**

- **Delivered:** an itemized customer-facing receipt document exists and is
  retrievable for a completed order, containing real line items, quantities,
  sale-time names, money, tax amounts, totals and tenders.
- **NOT delivered (each remains NOT IMPLEMENTED inside FR-POS-100):**
  tax registration number · invoice sequence · country-pack-mandated tax
  breakdown · required QR code · the country-pack element set as a whole ·
  the verb **"print"**.

Any future report or dashboard that renders FR-POS-100 as satisfied on the
strength of this slice is **wrong**, and this paragraph is the citation that
says so.

### A.4 Supporting SRS evidence — the SRS already has a non-fiscal document class

**UC-POS-01, SRS line 2440:**

> "9. Customer requests bill. Waiter prints the **pre-bill (non-fiscal)**."

and **SRS line 2446:**

> "14. System prints the **fiscal receipt** and, where required, queues fiscal
> submission via the outbox."

The SRS therefore **already distinguishes a non-fiscal customer document from
the fiscal receipt** in its own primary POS use case. The ratified Internal-MVP
receipt occupies that same non-fiscal document class — it is not a category the
SRS lacks vocabulary for. (No FR governs the pre-bill; this is cited as
supporting evidence for the document class, **not** as a requirement the slice
satisfies.)

### A.5 Adjacent requirements that bear on the design

| Requirement | Line | Relevance |
|---|---|---|
| **FR-FIN-031 [M]** — "The System SHALL support **tax-inclusive and tax-exclusive** pricing" | 3880 | **Directly forces §J's `taxPresentation` discriminator.** A receipt that cannot say which mode applied cannot be printed truthfully. |
| **FR-FIN-034 [M]** — "Tax SHALL be computed at **line level and summed**, not computed on the order total" | 3884 | The receipt sums nothing; it reads the already-summed persisted totals. Cited in `order-lines.service.ts:911`. |
| **FR-LOC-021 [M]** — packs versioned; "historical transactions SHALL be interpreted under the pack version in force" | 4900 | `orders.country_pack_version` is pinned per order. Exposed as **provenance only** (§K). |
| **FR-POS-066** | — | Card data limits. The receipt exposes **strictly less** than the row can hold (§I.4). |
| **FR-AUD-001** | — | Audit binds state-changing operations. The receipt changes no state (§17/§P). |
| **§15.2 `pos.reprint.receipt`** | 3606 | Exists in the SRS catalogue; deliberately **not** adopted (§F). |

---

## §B. EXACT RATIFIED INTERNAL-MVP SCOPE

The user has ratified: **the Internal MVP will include a NON-FISCAL ITEMIZED
RECEIPT.** This is not re-opened, re-designed, or re-litigated here.

**IN SCOPE — the receipt represents an already-completed sale, truthfully:**

1. Itemized document for a **completed** order
2. Real order identity — `orders.id` + `orders.order_number`
3. Real branch identity — `orders.branch_id`
4. Real business day — `orders.business_day`
5. Completion timestamp — `orders.completed_at`
6. Currency — `orders.currency`
7. Sold lines, with quantity
8. Item + variant display names **as stored at sale time**
9. Modifier display information from the completed-order snapshot
10. Line totals
11. Subtotal
12. Applied discounts **that actually exist** (see §B.1)
13. Tax totals **that actually exist**
14. Grand total
15. Tender / payment summary
16. Order type
17. **Clear, machine-readable non-fiscal disclosure**

### B.1 An honest note on limb 12 (discounts)

**Discounts are NOT implemented in this system.**
`order-lines.service.ts:328` writes `lineDiscount: 0n` unconditionally, and
`recomputeOrderTotals` (`order-lines.service.ts:968`) states verbatim:

> "`discountTotal`, `serviceChargeTotal` and `roundingAdjustment` are NOT
> recomputed here — discounts (BR-FIN-003), service charge and cash rounding
> (BR-FIN-004) are not implemented, so this slice must not pretend to maintain
> them. They stay at their defaults of 0."

The ratified limb is *"applied discounts **that actually exist**"*. Under
current runtime, **none exist**. The receipt therefore reports the persisted
`discountTotal` and per-line `lineDiscount` **verbatim** — which is `"0"` — and
invents nothing. This is limb 12 satisfied exactly as worded, not skipped.
(`orders.rounding_adjustment` is the one member of that trio that *is* written
after all — by cash Payment capture, not by line capture. See §J.4.)

---

## §C. EXACT EXCLUSIONS

Each of the following is **OUT OF SCOPE** for this slice and stays out. The
design below creates no partial version of any of them.

**Fiscal / legal:** legal or fiscal invoice numbering · invoice sequence ·
fiscal UUID · tax-authority submission · tax-authority acknowledgment ·
fiscal QR · country-pack fiscal fields · fiscal signature · legal invoice
numbering rules · fiscal cancellation/reversal documents · **country-pack
tax breakdown** (an FR-POS-100 mandated element — see §J.5).

**Delivery:** SMS · WhatsApp · email · customer contact collection.

**Presentation:** template editor · multi-template engine · logo ·
header/footer · configurable bilingual layout/ordering.

**Printing:** printer spooler · print retry queue · device-driver integration ·
printer health · printer routing.

**Persistence / platform:** offline receipt sync · archival service beyond
existing order persistence · accounting export · new fiscal tables · new
fiscal events · receipt table · receipt snapshot table · receipt sequence ·
reprint counter · reprint log.

**Explicitly not expanded** because the full SRS eventually requires them.
Every one of these is exactly why FR-POS-100 stays PARTIAL and FR-POS-101/103/
104/106 stay NOT IMPLEMENTED.

---

## §D. RECEIPT OWNER MODULE

> ## **OWNER: `Sales`**

Not "preferred" — **forced by the data**. Every single fact the receipt needs
lives in a table in the **`sales`** PostgreSQL schema, owned by the Sales
bounded context:

| Table | Schema | Owner |
|---|---|---|
| `orders` | `sales` | Sales |
| `order_lines` | `sales` | Sales |
| `order_line_modifiers` | `sales` | Sales |
| `order_payments` | `sales` | Sales |

Verified in `prisma/schema.prisma` — each model carries `@@schema("sales")`
(`Order` L1836, `OrderLine` L1896, `OrderLineModifier` L1958, `OrderPayment`
L2060).

**No standalone Receipt module is created.** SRS §5.2 does not warrant a
bounded context whose entire substance is a projection of another context's
aggregate.

**Payments do not cross a boundary.** This is worth stating plainly because it
was a live risk in the task framing: `OrderPayment` is **not** a Treasury
table. Its doc comment (schema L2044–2049) records that it is Sales-owned and
that `CashSession` attribution is carried on the Payment row itself. Treasury
is consulted at **capture** time through `CASH_SESSION_FACTS_QUERY`; at **read**
time nothing outside Sales is needed.

---

## §E. EXACT API ROUTE / METHOD

> ## `GET /orders/{businessDay}/{id}/receipt`

### E.1 Why this shape

`OrdersController` (`@Controller('orders')`) already publishes exactly this
family, documented in its own header comment (L331–347):

```
POST   /orders                                  open an order
GET    /orders                                  list, cursor-paginated
GET    /orders/:businessDay/:id                 one order, lines + ETag
POST   /orders/:businessDay/:id/lines           capture a line
DELETE /orders/:businessDay/:id/lines/:lineId   void a PRE-FIRE line
POST   /orders/:businessDay/:id/fire            fire eligible pending lines
POST   /orders/:businessDay/:id/payments        capture a payment
```

`…/receipt` is the seventh member of an existing, consistent family. No new
controller, no new route prefix, no new path-parameter vocabulary.

`{businessDay}` is **mandatory in the path** and is not decoration:
`sales.orders` is **partitioned**, and `(id, businessDay)` is its composite
primary key (`@@id([id, businessDay])`). Reading by `id` alone would scan every
partition. The existing `GET /orders/:businessDay/:id` documents this reasoning
verbatim (controller L415–419).

### E.2 GET, and why not POST

**GET.** The operation creates nothing, writes nothing, and is deterministic.
§10 of the task asks that a POST be justified if proposed; **none is proposed**.
A POST purely to "generate" a deterministic projection would be a lie about the
operation's nature, would attract an `Idempotency-Key` requirement it does not
need, and would invite a future implementer to add a side effect because the
verb permits one.

### E.3 Required characteristics — each satisfied

| Requirement | How |
|---|---|
| GET / read-only, no state created | Single `findUnique` + two `findMany`, no write of any kind (§P) |
| No `Idempotency-Key` | Not a mutation. `@Idempotent()` is **not** applied. |
| Concrete OpenAPI success schema | §Q — fully typed, no `schema: {}`, no bare `type: object` for known structure |
| Shared `ErrorResponse` / Problem Details | Automatic — `oas31.util.ts:186 fillErrorResponseSchemas` injects the shared `$ref` for every documented error status |
| Tenant isolation | `prisma.withAuthContext({tenantId})` + RLS `orders_select` / `order_payments_select` (§F.3) |
| Same order identity contract as existing Sales API | Identical `OrderPathParamsDto` and identical `parseBusinessDay` (controller L890) |
| No hidden DB mutation | §P |
| No audit event for reading | §P |
| No `If-Match` / ETag required | A read needs no precondition. Emitting the order's ETag is **optional**; §K.6 recommends **not** emitting one, so the receipt document carries no mutable-version coupling. |

### E.4 OpenAPI route-allowlist compatibility — verified

`test/openapi.e2e-spec.ts:275` asserts an exact route surface and a forbidden-
pattern list. The new path was checked against every pattern in that test:

| Assertion / pattern | Does `/orders/{businessDay}/{id}/receipt` trip it? |
|---|---|
| `fireMatches === ['/orders/{businessDay}/{id}/fire']` | No — `/\/fire\b/i` does not match |
| `paymentMatches === ['/orders/{businessDay}/{id}/payments']` | No — `/\/payments?\b/i` does not match `receipt` |
| `kdsMatches` (exact 6) | No — does not start with `/kds` |
| forbidden `/\/complete\b/i` | No |
| forbidden `/\/refunds?\b/i` | No |
| forbidden `/\/serve\b/i` | No |
| forbidden `/\/cancel/i` | No |
| forbidden `/payment[-_]?attempts?/i` | No |
| forbidden `/terminals?\/(session\|authoriz\|capture)/i` | No |
| `does not expose a /kitchen surface` | No |

**No existing OpenAPI assertion breaks.** §R.4 nevertheless recommends
*extending* that test with one positive assertion, to keep the repository's
"exactly one exact route" discipline intact.

---

## §F. AUTHORIZATION

> ## **`pos.order.create` — reused. NEW PERMISSIONS: NONE.**

### F.1 Why reuse, and why this one

`sales.permissions.ts` L20–27 records the repository's already-ratified reading
of the SRS §15.2 catalogue, verbatim:

> "§15.2 defines no `pos.order.read`. Inventing one would break the discipline;
> leaving reads unguarded would be worse. The catalogue entry is 'Create and
> **MODIFY** orders', and a terminal cannot modify an order it may not read …
> Reads therefore sit behind the same capability, and **no route grants
> visibility that `pos.order.create` does not already imply**."

`GET /orders/{businessDay}/{id}` — which already returns **every** line
snapshot, **every** money field and the order's totals — sits behind
`SALES_PERMISSIONS.ORDER_CREATE` today (controller L422).

The receipt is a **strict subset** of that order's facts plus its payments.
A principal holding `pos.order.create` can already read all of it. Reusing the
code therefore grants **exactly zero** new visibility. That is the narrowest
possible posture: not "the narrowest code that exists", but "the code under
which this data is already readable".

### F.2 Why NOT `pos.reprint.receipt`

`pos.reprint.receipt` ("Reprint a receipt") **does** exist in SRS §15.2
(line 3606). It is deliberately **not** adopted:

1. **It authorises the wrong verb.** Its subject is *reprint* — the FR-POS-104
   capability whose substance is duplicate-marking and logging. Neither is
   built. Attaching the code to a plain first read would misrepresent what the
   route does and would make FR-POS-104 look addressed.
2. **It would be new grantable authority.** Adopting it means a new
   `PermissionDef`, a new seeded row, and a new capability tenants must
   administer — for a read they can already perform.
3. **It must stay reserved.** When FR-POS-104 is genuinely built, this is the
   code it needs, with its duplicate-marking and logging semantics intact.
   Spending it now on a read would leave that slice with no vocabulary.

**Recommendation: leave `pos.reprint.receipt` unimplemented and unclaimed.**

Also **not** used: `report.view.financial` (a deliberately narrow RPT-R1
reporting code, which the register forbids broadening), and any
admin/financial code. §12's "do not reuse an overly broad financial/admin
permission merely because it exists" is honoured.

### F.3 Guard chain and tenant isolation — unchanged

Class-level on `OrdersController`:
`JwtAuthGuard` (401) → `TenantContextGuard` (403) → `PermissionGuard` (403),
with `@AllowPosSession()` so PIN-issued POS sessions may call it (FR-SEC-021).
The new handler inherits all of it and adds
`@RequirePermission(SALES_PERMISSIONS.ORDER_CREATE)`.

Tenant isolation is **fail-closed at the database**, not at the service:
`prisma.withAuthContext({ tenantId }, …)` — the same call `OrdersService.findOne`
uses (`orders.service.ts:374`) — under RLS policies `orders_select`
(`20260820120000_sales_order_foundation/migration.sql:307`) and
`order_payments_select` (`20260824100000_sales_order_payment_capture/migration.sql:132`).

A cross-tenant order id is **invisible**, so the query returns `null` and the
route answers **404, never 403** — the repository's stated convention
(controller L344–346), which prevents a response from disclosing another
tenant's data.

### F.4 D-2 is not reopened

No handler consults `TenantContext.branchId`. Authorization stays
**tenant-scoped**. The accepted Internal-MVP single-active-branch fail-closed
posture is untouched, and branch safety continues to come from terminal binding
and the employee's permitted-branch set (FR-SEC-021 facts), exactly as
`sales.permissions.ts` L29–34 records.

---

## §G. DATA-SOURCE MAPPING — FIELD BY FIELD

Every response field, its exact source column, and its provenance class.

**Provenance classes:**
**SNAPSHOT** = written at sale time, never rewritten ·
**IMMUTABLE** = written once at creation/completion, frozen by BR-POS-001 ·
**DERIVED** = computed at read time from the frozen row **only**, never from
master data.

### G.1 Document classification

| Response field | Source | Class |
|---|---|---|
| `documentType` | constant `"INTERNAL_NON_FISCAL_RECEIPT"` | constant |
| `fiscal` | constant `false` | constant |
| `disclosureKey` | constant `"receipt.internal.nonFiscal"` | constant |

### G.2 Order identity

| Response field | Source column | Class |
|---|---|---|
| `order.id` | `sales.orders.id` | IMMUTABLE |
| `order.orderNumber` | `sales.orders.order_number` | IMMUTABLE (FR-POS-002, terminal block) |
| `order.businessDay` | `sales.orders.business_day` | IMMUTABLE (partition key) |
| `order.branchId` | `sales.orders.branch_id` | IMMUTABLE |
| `order.terminalId` | `sales.orders.terminal_id` | IMMUTABLE |
| `order.orderType` | `sales.orders.order_type` | IMMUTABLE (`NOT NULL` enum) |
| `order.channel` | `sales.orders.channel` | IMMUTABLE |
| `order.state` | `sales.orders.state` | IMMUTABLE (always `"completed"` — §K.2) |
| `order.completedAt` | `sales.orders.completed_at` | IMMUTABLE (server clock at completion) |
| `order.currency` | `sales.orders.currency` | IMMUTABLE (`CHAR(3)`, server-derived) |
| `order.countryPackVersion` | `sales.orders.country_pack_version` | IMMUTABLE (FR-LOC-021 pin; provenance only) |

### G.3 Lines

Line set = `order_lines` where `state NOT IN ('voided','comped')`, ordered by
`sequence ASC`. **This filter is copied exactly from `recomputeOrderTotals`**
(`order-lines.service.ts:931`) — see §H.6 for why that identity matters.

| Response field | Source column | Class |
|---|---|---|
| `lines[].sequence` | `order_lines.sequence` | IMMUTABLE |
| `lines[].menuItemId` | `order_lines.menu_item_id` | IMMUTABLE |
| `lines[].variantId` | `order_lines.variant_id` | IMMUTABLE |
| `lines[].itemNameSnapshot` | `order_lines.item_name_snapshot` (`JSONB`) | **SNAPSHOT** |
| `lines[].quantity` | `order_lines.quantity` (`Decimal(12,3)`) | IMMUTABLE |
| `lines[].unitPrice` | `order_lines.unit_price` (`BigInt`) | **SNAPSHOT** |
| `lines[].modifierTotal` | `order_lines.modifier_total` | **SNAPSHOT** |
| `lines[].lineDiscount` | `order_lines.line_discount` | **SNAPSHOT** (always `0` — §B.1) |
| `lines[].lineSubtotal` | `order_lines.line_subtotal` | **SNAPSHOT** |
| `lines[].taxClassId` | `order_lines.tax_class_id` | **SNAPSHOT** |
| `lines[].taxAmount` | `order_lines.tax_amount` | **SNAPSHOT** |
| `lines[].lineTotal` | `order_lines.line_total` | **SNAPSHOT** |

### G.4 Modifiers

Per line, from `order_line_modifiers` (FK `(tenant_id, order_line_id,
business_day)`), ordered deterministically by `(id ASC)`.

| Response field | Source column | Class |
|---|---|---|
| `lines[].modifiers[].modifierId` | `order_line_modifiers.modifier_id` | IMMUTABLE |
| `lines[].modifiers[].nameSnapshot` | `order_line_modifiers.name_snapshot` (`JSONB`) | **SNAPSHOT** |
| `lines[].modifiers[].quantity` | `order_line_modifiers.quantity` | IMMUTABLE |
| `lines[].modifiers[].priceDelta` | `order_line_modifiers.price_delta` | **SNAPSHOT** |

### G.5 Totals — verbatim persisted order facts

| Response field | Source column | Class |
|---|---|---|
| `totals.subtotal` | `sales.orders.subtotal` | IMMUTABLE |
| `totals.discountTotal` | `sales.orders.discount_total` | IMMUTABLE (always `0`) |
| `totals.serviceChargeTotal` | `sales.orders.service_charge_total` | IMMUTABLE (always `0`) |
| `totals.taxTotal` | `sales.orders.tax_total` | IMMUTABLE |
| `totals.grandTotal` | `sales.orders.grand_total` | IMMUTABLE |
| `totals.paidTotal` | `sales.orders.paid_total` | IMMUTABLE |
| `totals.tipTotal` | `sales.orders.tip_total` | IMMUTABLE (always `0` — tips not implemented) |
| `totals.cashRoundingAdjustment` | `sales.orders.rounding_adjustment` | IMMUTABLE (§J.4) |

### G.6 Payments

From `sales.order_payments` where `(tenant_id, order_id, business_day)` matches
— an existing index, `@@index([tenantId, orderId, businessDay])`. Ordered by
`processed_at ASC, id ASC` (deterministic even on a same-instant tie).

| Response field | Source column | Class |
|---|---|---|
| `payments[].id` | `order_payments.id` | IMMUTABLE (append-only table) |
| `payments[].tender` | `order_payments.tender` | IMMUTABLE |
| `payments[].currency` | `order_payments.currency` | **SNAPSHOT** of order currency at capture |
| `payments[].amount` | `order_payments.amount` | IMMUTABLE |
| `payments[].roundingAdjustment` | `order_payments.rounding_adjustment` | IMMUTABLE |
| `payments[].tenderedAmount` | `order_payments.tendered_amount` | IMMUTABLE (`null` for card) |
| `payments[].changeGiven` | `order_payments.change_given` | IMMUTABLE (`null` for card) |
| `payments[].cardScheme` | `order_payments.card_scheme` | IMMUTABLE (`null` for cash) |
| `payments[].cardLast4` | `order_payments.card_last4` | IMMUTABLE (`null` for cash) |
| `payments[].processedAt` | `order_payments.processed_at` | IMMUTABLE (server clock) |

### G.7 Derived — the only two

| Response field | Derivation | Input |
|---|---|---|
| `taxPresentation` | §J.2 pure function | `totals.subtotal`, `totals.taxTotal`, `totals.grandTotal` — the frozen order row **only** |
| (line/modifier ordering) | `sequence ASC` / `id ASC` | frozen rows only |

**No response field is resolved from Catalogue, Localisation, Organisation,
Production, Treasury, Identity or any live master data.** See §N.

---

## §H. HISTORICAL STABILITY PROOF

The requirement (§6 of the task): the receipt must not silently change because
catalogue configuration changes later.

### H.1 The schema states the rule explicitly

`prisma/schema.prisma:1905`, on `OrderLine.itemNameSnapshot`:

> `/// BR-POS-004 sale-time snapshots — never recomputed from master data.`

`prisma/schema.prisma:1974`, on `OrderLineModifier.kindSnapshot`:

> `/// FR-POS-021 [M] / BR-POS-004 sale-time snapshot … copies the source
> Modifier's kind verbatim at capture time — never re-derived, never defaulted.`

### H.2 The capture code proves it is honoured

`order-lines.service.ts:320–324`:

```ts
// BR-POS-004 snapshots. Copied now; never re-derived.
itemNameSnapshot: {
  item: menuItem.names,
  variant: variant.name,
},
```

`order-lines.service.ts:361`:

```ts
nameSnapshot: modifier.name as Prisma.InputJsonValue,
```

Both the **item name map** and the **variant name map** are copied into the
`JSONB` column at capture. `Modifier.name` likewise. A later rename of the
`MenuItem`, the `MenuItemVariant` or the `Modifier` in Catalogue cannot reach
these columns — there is no code path that rewrites them.

### H.3 Money is snapshot, not resolved

`unit_price`, `modifier_total`, `line_discount`, `line_subtotal`, `tax_amount`
and `line_total` are all `BigInt` **columns on the line row**, written once at
capture from the pricing/tax resolution of that moment. `price_list_id`,
`price_entry_id` and `price_rule` record FR-POS-042 provenance. Re-pricing the
menu changes `catalogue.price_entries`; it does not change one byte of a
captured line.

### H.4 Tax cannot drift, by two independent mechanisms

1. `order_lines.tax_amount` is the **computed amount**, stored. It is not a
   rate to be re-applied.
2. `orders.country_pack_version` pins the pack version (FR-LOC-021), and
   `CountryPackRegistry` refuses to re-register a version with different
   content (`country-pack.registry.ts:111–116`: *"A published version is
   immutable (FR-LOC-021)"*).

CARRIED ITEM P1C-1 states the same separation in the register
(`GOVERNANCE_DECISION_REGISTER.md:5161–5165`): *"A TaxClass owns no rates …
which is exactly what lets a pack change the rate on `standard` without
rewriting a historical sale."*

**The receipt reads mechanism (1) only.** It never resolves a rate at all.

### H.5 The order itself is frozen after completion

`order-state.ts:43–48` — `completed` is in `FINALISED`.
`order-state.ts:87` — `completed: []`, i.e. **no outbound transition exists**.
BR-POS-001, quoted at `order-state.ts:173`: *"a COMPLETED order is immutable,
for every actor."* Clarification C (`order-state.ts:22–24`): *"after COMPLETED —
nobody edits the original; correction is a Refund"* — and refunds are not
implemented (`partially_refunded` / `refunded` have no inbound transition).

### H.6 The Σ-lines ≡ totals invariant — provable, not hoped for

`recomputeOrderTotals` (`order-lines.service.ts:917–972`) computes, over
`order_lines` with `state NOT IN ('voided','comped')`:

```
subtotal   = Σ lineSubtotal
taxTotal   = Σ taxAmount
grandTotal = Σ lineTotal
```

The receipt's line set uses **the identical filter**. Therefore, on a completed
order:

```
Σ lines[].lineSubtotal ≡ totals.subtotal
Σ lines[].taxAmount    ≡ totals.taxTotal
Σ lines[].lineTotal    ≡ totals.grandTotal
```

These are **exact bigint equalities** — no rounding, no tolerance. They are
directly assertable in e2e (test **E**, §R).

**Why `comped` is in the filter even though comp is not implemented.**
`sales/contract/daily-trading-sales.query.ts:61–62` records that *"an `isComp`
line that has not yet reached `comped` cannot occur on a `completed` order under
the current"* runtime, and no code anywhere writes `state: 'comped'` or
`isComp: true` (grep across `src/`: zero writers). Copying the filter rather
than simplifying it means the invariant survives a future comp implementation
**automatically**, instead of silently breaking.

**Why voided lines are excluded.** `order-lines.service.ts:913`: *"a voided
line is evidence, not revenue."* The only void path in the system is
**pre-fire** (`DELETE …/lines/:lineId`, `pos.order.void_line_prefire`), so a
voided line was never sent to the kitchen and the customer never received it.
Printing it would be the untruthful choice.

### H.7 Verdict

> **CASE A — the receipt can be reconstructed from sale-time facts safely.**
> **NOT case B.** No missing historical snapshot. No broader product change.
> **No RECEIPT HISTORICAL-DATA BLOCKER.**

---

## §I. PAYMENT / TENDER MAPPING

### I.1 The tenders that actually exist

`OrderPaymentTender` supports exactly **`CASH`** and **`MANUAL_EXTERNAL_CARD`**
(P1F-1). The schema doc comment (L2043) is explicit that *"CASH and
MANUAL_EXTERNAL_CARD in this MVP have no PaymentAttempt at all (the cashier
already completed the card transaction independently; ROS records the successful
result)"*. FR-POS-064 (integrated card lifecycle) is **NOT IMPLEMENTED**.

The receipt reflects **only** these two. No tender is invented.

### I.2 Per-payment entries, not an aggregate

`payments[]` lists **each captured Payment row**. §8 of the task permits either
individual entries or a truthful aggregate; individual entries are chosen
because they are **lossless** (a split-tender sale shows its real composition)
and require **no aggregation code to test**. The authoritative aggregate —
`totals.paidTotal` — is already a persisted column and is returned alongside;
computing a second, redundant `byTender` roll-up would add derived arithmetic
for no information gain.

### I.3 Multiple payments are a real, supported runtime truth

`order-state.ts:80–86` documents the two settling paths:

- `open → completed` — a single full-settlement Payment
- `partially_paid → completed` — the settling split-tender Payment

Both are legal today. Test **C** (§R) covers the mixed/multi-tender case, which
is therefore **required**, not speculative.

### I.4 Card metadata — strictly less than the row can hold

The row can hold `card_scheme`, `card_last4`, `authorization_code` and
`payment_terminal_txn_ref` — exactly FR-POS-066's permitted list, and
**structurally nothing else**: the schema doc (L2057) records *"no PAN, CVV,
track/magstripe data — there is no field that could hold one."*

**The receipt exposes only `cardScheme` and `cardLast4`.**

Deliberately **excluded**: `authorizationCode` and `paymentTerminalTxnRef`.
Both are **merchant-side reconciliation references**, not facts the customer's
copy needs to represent the sale; and printing an authorisation code on a
document would invite reading it as a card slip, which this document is not.
Neither is lost — both remain on the existing payment-capture response
(`toPaymentView`, `sales.views.ts`).

Also **excluded** as internal financial-control facts, not receipt facts:
`cashSessionId`, `employeeId`, `terminalId`.

**No sensitive card credential is exposed. None can be.**

### I.5 Runtime truths the receipt must represent — audited

| Question | Source finding | Receipt behaviour |
|---|---|---|
| Zero grand total? | `sales-payment.service.ts:127` rejects `amountMinor <= 0`; settlement is `newPaidTotal >= grandTotal` (L292). A `grandTotal = 0` order can only complete via a `> 0` payment, i.e. as an overpayment. Structurally reachable, operationally pathological. | Rendered truthfully: `grandTotal: "0"`, `paidTotal` as stored. No special case, no error. |
| Multiple tenders? | **Yes** (§I.3) | Each Payment listed |
| Captured excess (overpayment)? | **Yes** — settlement is `>=`, not `==`, so `paidTotal` may exceed `grandTotal`. `test/reporting-overpayment.e2e-spec.ts` exists, confirming this is a handled, known truth. | Both values shown verbatim; the receipt does **not** manufacture a "change due" figure. Real change is `payments[].changeGiven`, persisted per cash payment. |
| Refunds? | **NOT IMPLEMENTED** — `partially_refunded` / `refunded` have **no inbound transition** (`order-state.ts:88–89`). | Not represented. No refund field exists in the contract. |
| Voided lines? | Pre-fire only | Excluded from `lines[]` (§H.6) |
| Post-fire voids? | **Structurally unreachable** — `pos.order.void_line_postfire` is catalogued and deliberately unimplemented (`sales.permissions.ts:16–18`) | Not represented |

**No unsupported refund or post-fire-void semantics are introduced.**

---

## §J. MONEY / TAX MAPPING

### J.1 Wire conventions — preserved exactly, not re-invented

`sales.views.ts:3–12` states the rule:

> "BigInt money is serialised as a **STRING of minor units**. A JSON number
> would be IEEE-754 and would corrupt a large total silently, which ADR-008
> forbids."

The receipt uses `moneyStringSchema()` (`common/openapi/schema-helpers.ts`,
pattern `^-?\d+$`) for **every** money field, `decimalStringSchema()` for
`quantity`, `businessDaySchema()` for `businessDay`, `isoDateTimeSchema()` for
instants, `uuidSchema()` for ids. **Zero floating-point money. Zero new
convention.**

**The receipt performs no pricing arithmetic.** It does not recompute a price,
a tax, a discount, a subtotal or a total. It reads finalized columns. The only
arithmetic anywhere in the slice is the pure comparison in §J.2, which produces
a **label**, not a number.

### J.2 `taxPresentation` — the one derived field

**Why it is needed.** FR-FIN-031 [M] requires support for **both** tax-inclusive
and tax-exclusive pricing, and `order-lines.service.ts:306–310` implements both:

```ts
const lineTotal =
  pack.tax.pricingMode === 'tax_inclusive'
    ? lineSubtotal
    : lineSubtotal + lineTax.taxAmount.amount;
```

A client handed `subtotal`, `taxTotal` and `grandTotal` with no mode indicator
would render `subtotal + tax = total` — **correct under exclusive pricing and a
visible double-count under inclusive pricing**. A receipt that can print a false
total is not a truthful receipt. The discriminator is therefore **required**,
not decorative.

**Derivation — from the frozen order row only:**

```
if taxTotal == 0                        -> "NOT_APPLICABLE"
else if grandTotal == subtotal          -> "INCLUSIVE"
else if grandTotal == subtotal+taxTotal -> "EXCLUSIVE"
else                                    -> "UNDETERMINED"
```

**Why this is sound.** The pricing mode is a property of the pack version, and
the pack version is pinned **per order** — so every line of one order shares one
mode. Combined with §H.6's `grandTotal = Σ lineTotal`, exactly one of the two
equalities holds whenever `taxTotal != 0`.

**`UNDETERMINED` is structurally unreachable under current runtime.** It exists
so a historically anomalous row yields an honest label instead of a 500. A
read-only historical document must never fail closed on data it merely cannot
classify.

**What this is not.** It is not a pricing recomputation and it does not consult
the country pack. §9's rule — *"No Pricing recomputation from current Catalogue
configuration"* — is honoured strictly.

**Why the country pack is NOT read.** The obvious alternative — resolve
`pack.tax.pricingMode` via `CountryPackService.requirePinned` — was evaluated
and **rejected on two grounds**:

1. `requirePinned(countryCode, version)` needs `branch.countryCode`, which the
   order does **not** store. Obtaining it means either a direct `tx.branch`
   query — the exact table-ownership violation
   `organisation/contract/branch-currency.query.ts:5–17` warns against, and
   which this design must not add — or a new Organisation contract query.
2. `branches.country_code` is **mutable master data**. Resolving the pack
   through today's branch country at **read** time would make the receipt
   depend on a mutable fact, which is precisely the historical-stability
   property §H exists to protect.

Deriving from the order's own frozen totals has neither problem.

### J.3 Tax representation

- Per line: `taxClassId` (the immutable semantic identity — P1C-1) and
  `taxAmount` (the computed, stored amount).
- Order level: `totals.taxTotal`, which FR-FIN-034 defines as the **sum of line
  taxes**, and which `recomputeOrderTotals` computes exactly that way.

No rate. No component. No re-derivation. No tax-engine call.

### J.4 Cash rounding — present, correctly labelled, never in the total

`orders.rounding_adjustment` **is** written — by cash Payment capture
(`sales-payment.service.ts:395`, `roundingAdjustment: { increment: … }`), not by
line capture. It can be non-zero on a real completed order, so omitting it would
make the document incomplete.

The schema doc (L2036–2041) fixes its meaning:

> "`roundingAdjustment` is a **SEPARATE, purely cash-drawer-reconciliation**
> figure (FR-FIN-004's '± Cash Rounding Adjustments' term); it is **never added
> to `paid_total`** and never absorbed into revenue or tax (BR-FIN-004)."

The receipt exposes it as `totals.cashRoundingAdjustment` and per-payment as
`payments[].roundingAdjustment`, with the OpenAPI description stating verbatim
that it is **not** part of `grandTotal` and **not** part of `paidTotal`. Naming
it `cashRoundingAdjustment` at the order level — rather than reusing the bare
`roundingAdjustment` of the order contract — is deliberate: it makes the
cash-drawer meaning unmissable on a document a person will read.

### J.5 Tax breakdown by class — deliberately EXCLUDED

A per-tax-class breakdown (`taxClassId` → net/tax/gross) was designed, costed,
and **rejected**. It was technically cheap: `LocalisationModule` already exports
`TAX_CLASS_LABELS_QUERY`, `SalesModule` already imports `LocalisationModule`,
and importing `localisation/contract` is a **legal** boundary edge that adds
**zero** `KNOWN_DEVIATIONS`. Reporting already does exactly this
(`daily-trading-report.service.ts:195–199`).

It is excluded on **three** grounds, in order of weight:

1. **It is a named fiscal element.** FR-POS-100 lists *"tax breakdown"* among
   the **country-pack-mandated** elements. §4 puts country-pack fiscal fields
   **out of scope**. Shipping it would move the document toward the fiscal
   receipt the ratification explicitly says this is not.
2. **It is the slice's only cross-module dependency.** Dropping it makes the
   entire implementation **Sales-internal** (§N) — no injected contract, no
   module wiring, no nullable-label failure mode, no second module in the blast
   radius.
3. **Nothing is lost.** `lines[].taxClassId` + `lines[].taxAmount` +
   `totals.taxTotal` let any consumer derive the grouping itself. What ROS does
   not do is **assert** it as a tax breakdown.

**Consequence, recorded honestly:** FR-POS-100's tax-breakdown element stays
**NOT IMPLEMENTED**, which is exactly what §A.3 already says.

---

## §K. RESPONSE CONTRACT

### K.1 Shape

```jsonc
{
  // ── non-fiscal discriminator (§L) ──────────────────────────────────────
  "documentType": "INTERNAL_NON_FISCAL_RECEIPT",   // single-value enum
  "fiscal": false,                                 // const false
  "disclosureKey": "receipt.internal.nonFiscal",   // localization key

  // ── order identity ─────────────────────────────────────────────────────
  "order": {
    "id": "0198f3a1-...-...",
    "orderNumber": "BR1-000042",         // FR-POS-002. NOT an invoice sequence.
    "businessDay": "2026-09-01",
    "branchId": "0198a0c2-...",
    "terminalId": "0198a0c3-...",
    "orderType": "dine_in",
    "channel": "pos",
    "state": "completed",                // single-value enum
    "completedAt": "2026-09-01T18:42:11.204Z",
    "currency": "AED",
    "countryPackVersion": "2026.1"       // STRING (§Q.4). Provenance only.
  },

  // ── itemized lines ─────────────────────────────────────────────────────
  "lines": [
    {
      "sequence": 1,
      "menuItemId": "0198b1...",
      "variantId": "0198b2...",
      "itemNameSnapshot": { "item": { "en": "Grilled Chicken Sandwich",
                                      "ar": "..." },
                            "variant": { "en": "Large", "ar": "..." } },
      "quantity": "2.000",
      "unitPrice": "2500",
      "modifiers": [
        { "modifierId": "0198c1...",
          "nameSnapshot": { "en": "Extra Garlic Sauce", "ar": "..." },
          "quantity": 1,
          "priceDelta": "200" }
      ],
      "modifierTotal": "400",
      "lineDiscount": "0",
      "lineSubtotal": "5400",
      "taxClassId": "0198d1...",
      "taxAmount": "756",
      "lineTotal": "6156"
    }
  ],

  // ── totals — verbatim persisted order facts ────────────────────────────
  "totals": {
    "subtotal": "5400",
    "discountTotal": "0",
    "serviceChargeTotal": "0",
    "taxTotal": "756",
    "grandTotal": "6156",
    "paidTotal": "6156",
    "tipTotal": "0",
    "cashRoundingAdjustment": "0"        // NEVER part of grandTotal/paidTotal
  },

  "taxPresentation": "EXCLUSIVE",        // INCLUSIVE | EXCLUSIVE
                                         // | NOT_APPLICABLE | UNDETERMINED

  // ── tenders ────────────────────────────────────────────────────────────
  "payments": [
    {
      "id": "0198e1...",
      "tender": "CASH",
      "currency": "AED",
      "amount": "6156",
      "roundingAdjustment": "0",
      "tenderedAmount": "7000",
      "changeGiven": "844",
      "cardScheme": null,
      "cardLast4": null,
      "processedAt": "2026-09-01T18:42:11.198Z"
    }
  ]
}
```

### K.2 `order.state` is a single-value enum

Documented as `enum: ["completed"]`, not the full nine-value `OrderState`. The
route cannot return anything else (§M), so the schema should not suggest it can.
This is the same "the contract says what is true" discipline the DayClose
`oneOf` union established.

### K.3 `orderNumber` is not an invoice sequence — stated in the contract

`orders.order_number` is FR-POS-002's `<branch_code>-<business_day_seq>`, drawn
from a **terminal block** (schema L1840–1841) precisely so it can be issued
offline. It is **not** gapless, **not** globally ordered, and **not** a fiscal
invoice sequence.

The OpenAPI `description` for this field must say so explicitly. This is a
**safety** requirement, not documentation polish: `orderNumber` is the field a
future UI is most likely to print in an "Invoice No." box.

### K.4 There is no `generatedAt`

**Deliberate.** A server-clock field would make two GETs of the same order
return different bytes, weakening §15's reprint determinism from *byte-identity*
to *field-subset equality*. With no clock field, the response is **byte-identical
across calls**, and test **H** (§R) becomes a strict deep-equality assertion
rather than a hand-maintained field comparison.

### K.5 Fields deliberately absent

| Absent | Why |
|---|---|
| `version` | Optimistic-concurrency machinery. A frozen document has no concurrency story. |
| `openedAt`, `firstFiredAt`, `originDeviceTime` | Operational timestamps, not sale facts |
| `openedBy`, `servedBy`, `closedBy` | Actor ids; resolving them to names would pull mutable Workforce/Identity master data into a historical document |
| `tableId`, `guestCount`, `notes` | Service-floor operational facts, not required by the ratified boundary |
| `unitCostSnapshot`, `postedCogsTotal`, `recipeVersionId` | **COGS. Internal margin data.** Must never reach a customer-facing document. |
| `priceListId`, `priceEntryId`, `priceRule` | FR-POS-042 pricing provenance — internal audit facts, not receipt facts |
| **branch name / brand name / logo** | Mutable Organisation master data. Including it would (a) create a cross-module dependency and (b) let a branch rename silently alter a historical receipt. `branchId` is the stable identity, and §4's ratified limb is *"real branch identity"*. **A branch display name is an FR-POS-101 template concern and is deferred with it.** |
| `authorizationCode`, `paymentTerminalTxnRef`, `cashSessionId`, `employeeId` (payments) | §I.4 |
| `taxBreakdown` | §J.5 |

### K.6 No ETag on this route

`GET /orders/{businessDay}/{id}` emits `W/"<id>.<version>"` because a client
needs it for the next `If-Match` mutation. The receipt is a document; there is
no next mutation. Emitting a version-derived validator would couple a frozen
document to a mutable counter for no caller benefit. **No `ETag` header.**

---

## §L. NON-FISCAL DISCRIMINATOR

Three fields, each doing a distinct job. None is redundant.

| Field | Type | Job |
|---|---|---|
| `documentType` | `enum: ["INTERNAL_NON_FISCAL_RECEIPT"]` | **Primary machine-readable classification.** A single-value enum, so a client that switches on it must handle this case explicitly and cannot silently default. |
| `fiscal` | `const false` | **Cheapest possible guard.** `if (!receipt.fiscal)` is the one-line check a reviewer will actually notice missing. |
| `disclosureKey` | `string` | **The visible line.** A localization key, not prose, so the rendered disclosure follows existing localization/style conventions (§4) rather than hard-coding English into an API. |

**Why not prose only.** §13 requires machine-readable classification. A
`disclaimer: "This is not a tax invoice"` string is untestable, unswitchable,
and silently dropped by any client that does not render it.

**Why all three.** They fail in different directions. A client could ignore
`documentType` (unknown-enum default), ignore `fiscal` (never reads booleans),
or ignore `disclosureKey` (does not render it) — but ignoring all three requires
active effort. The task's caution against "redundant flags" is about
*duplicated* signals; these are *layered* ones, at three different levels of the
stack (routing, guarding, rendering).

**What makes accidental fiscal presentation hard:**
- No `invoiceNumber` field exists to populate.
- No `taxRegistrationNumber` field exists.
- No `qrCode` field exists.
- No `fiscalUuid` / `fiscalSignature` / `submissionStatus` field exists.
- `orderNumber`'s own description says it is not an invoice sequence (§K.3).

A UI cannot present this as a legal fiscal receipt without **inventing** the
mandated elements itself — which is a visible act, not an oversight.

---

## §M. ERROR / STATUS BEHAVIOUR

### M.1 Status table

| Condition | Status | Mechanism |
|---|---|---|
| Completed order, authorized, same tenant | **200** | The receipt document |
| Malformed `businessDay` (e.g. `2026-02-31`) | **400** | `parseBusinessDay` → `BadRequestException` (controller L890–900) |
| Missing / invalid token | **401** | `JwtAuthGuard` |
| Missing `pos.order.create` | **403** | `PermissionGuard` |
| Unknown order id | **404** | `findUnique` → `null` → `NotFoundException('Order not found.')` |
| **Cross-tenant** order id | **404** *(never 403)* | RLS makes the row invisible; identical to the existing convention (controller L344–346) |
| Correct id, **wrong `businessDay`** | **404** | `(id, businessDay)` is the composite PK; a mismatch simply finds no row |
| Order exists but `state != 'completed'` | **422** | `ReceiptNotAvailableError extends OrderStateError` → `SalesDomainExceptionFilter` |

### M.2 Why 422 and not 409 for a non-completed order

`sales-domain-exception.filter.ts:30–32` states the repository's own rule:

> `409  the caller's precondition was stale — someone else got there first`
> `422  the request was well formed but the domain refuses it`

A GET on a `draft`/`open`/`partially_paid`/`cancelled` order carries **no
precondition** — nothing is stale, nothing raced. The request is well formed and
the domain refuses it. That is the 422 branch, exactly as written.

Not 404, because the order **does** exist and the caller **is** entitled to see
it (they can read it via `GET /orders/{businessDay}/{id}` with the same
permission). A 404 would be a lie about existence.

### M.3 Zero filter changes

`SalesDomainExceptionFilter` already `@Catch`es `OrderStateError`. A subclass
inherits the mapping. This is the same mechanism `fire.errors.ts` documents at
L2–8:

> "Both extend `OrderStateError` so `SalesDomainExceptionFilter`'s existing
> `@Catch(OrderStateError, …)` maps them to 422 **with zero filter changes**."

The subclass is worth its ~8 lines because `error.name` is echoed in the
response body, so the client sees `"ReceiptNotAvailableError"` rather than a
generic state error — actionable rather than merely correct.

### M.4 Error bodies are automatic

`oas31.util.ts:186 fillErrorResponseSchemas` injects the shared `ErrorResponse`
`$ref` into every documented error status across the whole document. Declaring
`@ApiUnprocessableEntityResponse({ description })` on the handler is sufficient;
401/403/404 are already declared at class level. `test/openapi.e2e-spec.ts:626`
("every operation carries a concrete schema for its documented
400/401/403/404/409/422 error responses") is satisfied without any new code.

---

## §N. MODULE-BOUNDARY NEEDS

> ## **ZERO. No cross-module dependency of any kind.**

| Check | Result |
|---|---|
| New `KNOWN_DEVIATIONS` entry | **NONE** |
| New private-path import | **NONE** |
| New `contract/` import | **NONE** |
| New module import in `SalesModule` | **NONE** |
| New published contract to design | **NONE** |
| Another module's Prisma table queried | **NONE** |
| New Sales `contract/` file | **NONE** — nothing outside Sales consumes this |

`module-boundaries.spec.ts` currently records `sales->catalogue`,
`sales->governance`, `sales->identity`, `sales->localisation`,
`sales->production` and (legally, via `contract/`) `sales->organisation`. **This
slice adds nothing to any of them**, because §J.5 removed the only candidate
edge.

**Table-ownership compliance** — the stricter test that
`branch-currency.query.ts:5–17` warns the import-scan cannot see: every table
the receipt reads (`sales.orders`, `sales.order_lines`,
`sales.order_line_modifiers`, `sales.order_payments`) is **`@@schema("sales")`**
and Sales-owned. The receipt does **not** query `org.branches` — which is
exactly the violation `order-lines.service.ts:212` already commits at capture
time and which this design deliberately does not extend to the read path.

`module-boundaries.spec.ts` should remain at **45/45** with no edit.

> **No RECEIPT MODULE-BOUNDARY BLOCKER.**

---

## §O. ELIGIBILITY

> ## **`state === 'completed'`. Nothing else. Ever.**

| Order state | Receipt? | Reason |
|---|---|---|
| `draft` | **NO** → 422 | No sale happened |
| `open` | **NO** → 422 | Sale in progress; totals still mutable |
| `held` | **NO** → 422 | Same |
| `parked` | **NO** → 422 | Same |
| `partially_paid` | **NO** → 422 | **Explicitly refused.** Balance outstanding. A final receipt here would assert a settled sale that is not settled. |
| `completed` | **YES** → 200 | The only state in which the sale is final and the order is frozen |
| `cancelled` | **NO** → 422 | No sale to receipt |
| `partially_refunded` | **NO** → 422 | Unreachable today (no inbound transition). Refused rather than guessed. |
| `refunded` | **NO** → 422 | Same |

**No compelling SRS or source reason to widen this was found.** Specifically:
the SRS's own non-fiscal **pre-bill** (UC-POS-01 step 9, §A.4) *would* be the
document for an unpaid order — and it is **not** in the ratified §4 scope. This
slice must not become a pre-bill by accident, which is precisely what accepting
`open` or `partially_paid` would do.

The eligibility check is enforced in the service, before any projection work, so
a direct service call is refused identically to an HTTP request — the same
discipline `order-state.ts:5–8` describes.

---

## §P. MIGRATION, PERSISTENCE, AUDIT AND EVENT DECISIONS

```
NEW TABLES:        NONE
NEW COLUMNS:       NONE
NEW MIGRATIONS:    NONE   (migration count stays 35)
NEW SEQUENCES:     NONE
NEW INDEXES:       NONE
NEW ENUMS:         NONE
NEW RLS POLICIES:  NONE
NEW DOMAIN EVENTS: NONE
NEW AUDIT ACTIONS: NONE
NEW PERMISSIONS:   NONE
NEW PRISMA MODELS: NONE
```

### P.1 Migration — NO

§18's default holds and is **not** contradicted. §H proves every required fact
is already historically durable. There is nothing to persist.

**A receipt persistence model is not invented for convenience.** A
`receipts` / `receipt_snapshots` table would duplicate — and could therefore
**drift from** — the order facts it copies. The order row is already the
immutable record; a second copy is a correctness liability, not a safety
feature.

### P.2 No sequence

The document reference is the existing `orders.order_number`. A receipt sequence
would be an **invoice sequence** in all but name — an explicit §4 exclusion and
an FR-POS-100 mandated element.

### P.3 Indexes — the required ones already exist

| Query | Index | Source |
|---|---|---|
| order by `(id, businessDay)` | `@@id([id, businessDay])` | schema L1882 |
| lines by `(tenantId, orderId, businessDay)` | `@@index([tenantId, orderId, businessDay])` | schema L1951 |
| modifiers by `(tenantId, orderLineId)` | `@@index([tenantId, orderLineId])` | schema L1993 |
| payments by `(tenantId, orderId, businessDay)` | `@@index([tenantId, orderId, businessDay])` | schema L2154 |

**No new index. No migration on that ground either.**

### P.4 Audit — NO WRITE

FR-AUD-001 binds **state-changing** operations. This operation changes no state.

`AuditService` is **not injected** into the receipt service. That is stronger
than a policy note: the dependency does not exist, so no future edit can add an
audit write to this path without a visible constructor change and a review.

**No audit noise for repeated GETs** (§15). A receipt re-read 40 times during a
shift writes 0 rows.

> **If any future change introduces a mutation on this path, FR-AUD-001 applies
> in full and this decision is void.** Recorded here so that is unambiguous.

### P.5 No domain event

Nothing happened. `order.completed` was already published by
`sales-payment.service.ts:623` at the moment that mattered.

### P.6 The GET is provably read-only

The service body consists of exactly three Prisma reads —
`order.findUnique`, `orderLine.findMany` (with `include: { modifiers: true }`),
`orderPayment.findMany` — inside a single `prisma.withAuthContext` block. There
is no `create`, `update`, `upsert`, `delete`, `$executeRaw` or transaction.

Test **N** (§R) asserts this empirically at the database level, not by reading
the code.

---

## §Q. OPENAPI DESIGN

### Q.1 Requirements met from day one

- Concrete, fully typed 200 schema. **No `schema: {}`.** **No bare
  `type: 'object'`** for known structure.
- Every nested array typed via `items`; every nested object typed via
  `properties`.
- All existing helpers reused: `moneyStringSchema`, `decimalStringSchema`,
  `businessDaySchema`, `isoDateTimeSchema`, `uuidSchema`, `nullable`.
- Errors: shared `ErrorResponse` injected globally (§M.4).
- `@ApiOperation`, `@ApiOkResponse`, `@ApiUnprocessableEntityResponse` on the
  handler; 401/403/404 inherited from the class decorators.

### Q.2 The two legitimate opaque nested objects

`lines[].itemNameSnapshot` and `lines[].modifiers[].nameSnapshot` are genuinely
opaque `JSONB` locale→name maps. They are documented as
`{ type: 'object', description: '…' }` — the repository's **established,
deliberate convention** for opaque nested JSON columns, used across catalogue,
organisation, inventory and kitchen, and explicitly permitted by
`test/openapi.e2e-spec.ts:520–535`:

> "This check never walks into nested properties (so the repository's real
> nested opaque-JSON fields are untouched and not re-flagged)."

The **top-level** response schema is fully typed, so
`TOP_LEVEL_OPAQUE_ALLOWLIST` **stays empty** — no allowlist entry is added.

### Q.3 Which existing OpenAPI assertions auto-cover the new route

| `openapi.e2e-spec.ts` assertion | Effect |
|---|---|
| L460 "no live registered route is missing from the document" | Forces the route into the document |
| L473 "no documented operation is missing its live route" | Forces the reverse |
| L556 "every documented 2xx response … carries a concrete JSON schema" | Forces the typed 200 |
| L626 "every operation carries a concrete schema for its 400/401/403/404/409/422" | Forces typed errors |
| L316 "every non-public operation carries security metadata" | Forces the bearer requirement |
| L828 "every `{placeholder}` has exactly one matching in:path parameter, none optional" | Forces both path params |
| L856 "path parameters classified uuid/businessDay carry the exact expected type+format" | Forces `{id}`=uuid, `{businessDay}`=date |
| L205 "no duplicate operationIds" | Forces a unique operationId |
| L407 "no schema uses the OpenAPI-3.0-only `nullable` keyword" | Forces `type: [x, 'null']` unions after post-processing |

**Nine existing assertions cover the new endpoint with no test edits.** That is
the "automatically cover" property §17 asks for, and it already holds.

### Q.4 TWO PRE-EXISTING DEFECTS FOUND — reported, NOT fixed

Found this session by diffing `docs/api/openapi.json` against the actual
serializers in `sales.views.ts`. Both are in the **pre-existing order contract**,
both survived the 2026-09-01 full-API audit, and **both are out of this slice's
scope**:

| # | Location | Documented | Actually emitted | Evidence |
|---|---|---|---|---|
| **1** | `GET /orders/{businessDay}/{id}` → `countryPackVersion` | `{"type": "integer"}` | a **string** | Prisma `countryPackVersion String @db.VarChar(24)`; `toOrderView` returns it unchanged (`sales.views.ts:44`) |
| **2** | same → `lines[].priceRule` | `{"type": "object", "description": "Opaque pricing-rule provenance snapshot."}` | a **`string \| null`** | Prisma `priceRule String? @db.VarChar(160)`; `toOrderLineView` returns it unchanged (`sales.views.ts:71`) |

Also noted, lower severity: `lines[].taxClassId` is documented
`type: ["string","null"]` while `order_lines.tax_class_id` is `NOT NULL` — the
contract is over-permissive rather than wrong at runtime.

**Actions taken: none.** No source file was modified. These are recorded so
they are not lost, and so a future contract-correction slice has the exact
citations.

**The receipt schema does not repeat them:**
- `order.countryPackVersion` is typed **`string`**.
- `priceRule` is **not exposed at all** (§K.5).
- `lines[].taxClassId` is typed **non-nullable `uuid`**, matching the column.

### Q.5 Regeneration

`docs/api/openapi.json` and `docs/api/openapi.yaml` are regenerated by the
implementation run. Expected surface after the slice:

```
151 source routes  -> 152
151 OpenAPI ops    -> 152
0 mismatches       -> 0
111 paths          -> 112
```

---

## §R. DEDICATED TEST MATRIX

New file: **`test/receipt.e2e-spec.ts`**.

### R.1 Required scenarios

| # | Scenario | Assertion | Required? |
|---|---|---|---|
| **A** | Completed **CASH** order → receipt | 200; `payments` = 1 entry, `tender: "CASH"`, `tenderedAmount`/`changeGiven` non-null | **YES** |
| **B** | Completed **MANUAL_EXTERNAL_CARD** order → receipt | 200; `tender: "MANUAL_EXTERNAL_CARD"`; `tenderedAmount`/`changeGiven` **null**; `cardScheme`/`cardLast4` as captured; **no `authorizationCode`/`paymentTerminalTxnRef` key present** | **YES** |
| **C** | **Split tender** (partial cash → settling card) | 200; `payments.length === 2`, order preserved; `Σ payments[].amount === totals.paidTotal` | **YES** — supported runtime (§I.3) |
| **D** | **Modifiers** represented correctly | `lines[].modifiers` carries `nameSnapshot`, `priceDelta`, `quantity`; `Σ (priceDelta × quantity)` consistent with the captured `modifierTotal` | **YES** |
| **E** | **Totals / tax exact** | `Σ lineSubtotal === subtotal` **and** `Σ taxAmount === taxTotal` **and** `Σ lineTotal === grandTotal`, as exact `BigInt` (§H.6); `taxPresentation` matches the fixture's pack pricing mode | **YES** |
| **F** | **Discounts** | `totals.discountTotal === "0"` and every `lines[].lineDiscount === "0"` — asserting the *truthful zero*, since discounts are not implemented (§B.1) | **YES** (as a truthfulness assertion, not a feature test) |
| **G** | **Catalogue rename after completion** | Rename the `MenuItem`, the `MenuItemVariant` **and** the `Modifier` after completion; re-GET; `itemNameSnapshot` and `nameSnapshot` **unchanged** | **YES — the single most important test in the file** |
| **H** | **Repeat GET → identical** | Two GETs → **strict deep equality of the whole body** (possible only because there is no `generatedAt`, §K.4) | **YES** |
| **I** | **`open` order rejected** | 422, `error: "ReceiptNotAvailableError"` | **YES** |
| **J** | **`partially_paid` order rejected** | 422 | **YES** |
| **K** | **`cancelled` order rejected** | 422 | **YES** |
| **L** | **Wrong tenant cannot read** | Tenant B's token on tenant A's completed order → **404** (never 403) | **YES** |
| **M** | **Unauthorized principal** | Valid token **without** `pos.order.create` → **403**; no token → **401** | **YES** |
| **N** | **Identity mismatch** | Correct `id` + wrong `businessDay` → **404**; unknown `id` → **404**; malformed `businessDay` (`2026-02-31`) → **400** | **YES** |
| **O** | **OpenAPI schema present and concrete** | Covered by the nine existing assertions in §Q.3, plus the §R.4 addition | **YES** |
| **P** | **No DB mutation on GET** *(added — §19 clause 14)* | Capture `orders.version`, `updated_at`, and `COUNT(*)` of `governance.audit_entries` for the tenant before and after 3 GETs → **all unchanged** | **YES** |

### R.2 Scenarios deliberately NOT required

Per §20 ("do not require a scenario for unsupported product capability"):

| Not tested | Why |
|---|---|
| Refund on receipt | Refunds NOT IMPLEMENTED — no inbound transition exists |
| Post-fire void on receipt | Structurally unreachable |
| Comped line on receipt | Comp NOT IMPLEMENTED — no writer of `isComp`/`comped` exists |
| Non-zero discount | Discounts NOT IMPLEMENTED (F asserts the zero instead) |
| Service charge / tip | NOT IMPLEMENTED |
| Print / delivery | Out of scope (§C) |
| Zero-`grandTotal` order | Structurally reachable but operationally pathological (§I.5); **optional**, not required |

### R.3 One focused unit spec

**`src/modules/sales/receipt.views.spec.ts`** — pure, no DB, no Nest:

- `deriveTaxPresentation` over all four branches:
  `taxTotal = 0` → `NOT_APPLICABLE`;
  `grandTotal == subtotal` → `INCLUSIVE`;
  `grandTotal == subtotal + taxTotal` → `EXCLUSIVE`;
  a non-reconciling triple → `UNDETERMINED`.
- `toReceiptView` money serialization: every money field is a **decimal string
  of minor units**, never a JSON number; a `BigInt` beyond `Number.MAX_SAFE_INTEGER`
  survives round-trip unchanged.
- Voided lines excluded; the `(voided, comped)` filter matches
  `recomputeOrderTotals` exactly.
- Constant discriminators: `documentType`, `fiscal === false`, `disclosureKey`.
- No COGS field (`unitCostSnapshot`, `postedCogsTotal`, `recipeVersionId`) and
  no merchant payment reference (`authorizationCode`, `paymentTerminalTxnRef`)
  appears anywhere in the output — asserted by **key absence**, so a future
  careless spread cannot leak them silently.

### R.4 One assertion added to the existing OpenAPI suite

Inside the existing `it` at `test/openapi.e2e-spec.ts:275` (extending it, so the
suite stays at **46** tests rather than 47):

```ts
const receiptMatches = paths.filter((p) => /\/receipts?\b/i.test(p));
expect(receiptMatches).toEqual(['/orders/{businessDay}/{id}/receipt']);
```

This preserves the repository's "exactly one exact route, and only that one"
discipline that Fire, Payment and the KDS surface already follow. Without it,
a future slice could add `/orders/{…}/receipt/email` and no test would object.

The test's own `it` name and doc comment gain one sentence recording the
RCPT-R1 ratification, matching how P1E-6/P1F-1/KDS-R11 are recorded there.

---

## §S. REQUIREMENT CLASSIFICATIONS AFTER IMPLEMENTATION

```
FR-POS-100 [M]  NOT IMPLEMENTED -> PARTIAL
                (non-fiscal document body only; TRN, invoice sequence,
                 tax breakdown, QR, country-pack element set and printing
                 ALL remain NOT IMPLEMENTED within it)
FR-POS-101 [M]  NOT IMPLEMENTED   (unchanged)
FR-POS-102 [M]  NOT IMPLEMENTED   (unchanged)
FR-POS-103 [M]  NOT IMPLEMENTED   (unchanged)
FR-POS-104 [S]  NOT IMPLEMENTED   (unchanged — no duplicate marking, no log)
FR-POS-105 [M]  NOT IMPLEMENTED   (unchanged — kitchen printing)
FR-POS-106 [M]  NOT IMPLEMENTED   (unchanged — no printing subsystem)
```

**Unchanged elsewhere:** FR-FIN-031/034 keep their existing status — the receipt
*consumes* their output and implements neither. FR-LOC-021 keeps its existing
status — the receipt reads the pin as provenance and resolves no pack.

**No requirement anywhere moves to COMPLETE as a result of this slice.**

---

## §T. P1C-1 STATUS

### T.1 P1C-1's exact exclusion, quoted

`GOVERNANCE_DECISION_REGISTER.md:5172–5173`:

> "Fiscal remains otherwise out of scope: **no tax documents, invoice
> templates, fiscal submissions or `fiscal.tax_rules` table**."

### T.2 The four exclusions, checked one by one against this design

| P1C-1 exclusion | Does the slice create one? | Why not |
|---|---|---|
| **tax document** | **NO** | No document is persisted. Nothing is written. The response is a projection assembled per request and never stored. |
| **invoice template** | **NO** | No template engine, no layout, no logo/header/footer. The response is data; rendering is the client's. |
| **fiscal submission** | **NO** | No outbox topic, no submission, no acknowledgment, no `fiscal.submit` payload. |
| **`fiscal.tax_rules` table** | **NO** | No table, no migration, and no rate is read or applied anywhere. |

### T.3 Precise status wording

> **P1C-1 is NOT reopened, NOT amended, and NOT narrowed by this slice.**
>
> **P1C-1 REMAINS A BLOCKER** to the FULL FISCAL RECEIPT and to production
> fiscal compliance. Fiscal receipts, invoice numbering, tax documents,
> country-pack fiscal elements, fiscal QR, fiscal signature and tax-authority
> submission all remain out of scope under it.
>
> **P1C-1 DOES NOT BLOCK the controlled Internal MVP receipt**, because the
> designed capability creates **none of the four things P1C-1 excludes**. It is
> a read-only projection of already-persisted, already-accepted Sales facts.
>
> **P1C-1 IS NOT GLOBALLY CLOSED.** It is not closed at all. Any statement that
> "P1C-1 is resolved" or "the fiscal blocker is cleared" is **false**.

### T.4 A note on how prior reports framed this

`2026-09-01_INTERNAL-MVP-current-state.md` §6 recorded Receipt as "BLOCKED BY
P1C-1" and recorded the unresolved question as *"whether the Internal MVP
requires a non-fiscal receipt despite that exclusion"*.

**That question is now answered by the user's ratification — not by this
report.** And §T.2 shows the answer creates no tension with P1C-1's text: the
exclusion was always about **fiscal artefacts**, and a non-fiscal projection is
not one. The earlier "BLOCKED" framing was correct **as of a system with no
ratified position**; it is superseded by RCPT-R1, not contradicted by new
analysis.

---

## §U. GOVERNANCE ENTRY

### U.1 Naming convention — verified against the register

Recent entries are **unnumbered ratification sections** with per-limb ids:
`DC-R1…R3` (DayClose), `RPT-R1…R3` (Reporting), `KDS-R11/R12`, `R-6`. They do
**not** consume a `D-<n>` number and do **not** alter the 20-decision tally.

`RCPT-R1` follows that convention exactly. Collision check performed across the
register for `RCPT`, `RCPT-R`, and `receipt` as an id prefix: **no collision**.

### U.2 The entry to record

> ### RATIFICATION — RCPT-R1: INTERNAL-MVP NON-FISCAL RECEIPT (2026-09-01)
>
> **RATIFIED — binding:**
>
> 1. For the controlled **Internal MVP**, ROS exposes an **itemized receipt
>    view for completed orders** that is **explicitly non-fiscal** and makes
>    **no claim of legal or fiscal invoice compliance**.
> 2. This is a **sequencing / scope decision only**.
> 3. It **does NOT waive** any full-SRS fiscal requirement.
> 4. It **does NOT mark FR-POS-100 … FR-POS-106 COMPLETE**. FR-POS-100 becomes
>    **PARTIAL**; FR-POS-101/102/103/104/105/106 remain **NOT IMPLEMENTED**.
> 5. It **does NOT authorize deployment as a fiscal receipt** in any
>    jurisdiction.
> 6. It **does NOT alter CARRIED ITEM P1C-1** beyond this narrow Internal-MVP
>    carve-out. P1C-1 remains a blocker to the full fiscal receipt. The
>    capability creates **no tax document, no invoice template, no fiscal
>    submission and no `fiscal.tax_rules` table** — P1C-1's four named
>    exclusions are each untouched.
> 7. **Nothing else is reopened:** P-1 remains RATIFIED and UNCHANGED · D-12
>    remains BLOCKED · D-16's enumeration remains OPEN · D-13 remains RATIFIED ·
>    **D-2 is not reopened** · no Governance HTTP or read surface (D-14 A-1,
>    D-20) · KDS-R1 … KDS-R12, RPT-R1 … RPT-R3, DC-R1 … DC-R3, R-1(a) … R-6 all
>    unchanged.
> 8. This entry **amends no numbered decision**, **creates no schema**, and
>    **authorizes no migration**. All historical register text is preserved
>    verbatim and is not rewritten.

### U.3 No further ratification entries are proposed

§22 asks whether read-only-projection ownership and no-persistence deserve their
own entries. **They do not.** Both are ordinary engineering design conclusions
reached from source evidence (§D, §P), not user-governance decisions:

- **Ownership by Sales** is forced by table ownership (§D). There was no choice
  to ratify.
- **No persistence / no sequence** follows from §H proving the facts are
  already durable. Ratifying "we did not build a table we did not need" would
  be ceremonial.

Nor is a permission ratification needed: `pos.order.create` is reused, and its
read-side use is **already** the recorded repository position
(`sales.permissions.ts:20–27`). Unlike `pos.order.fire`, `pos.payment.capture`
and `kds.operate` — each of which needed a ratification **because it invented a
code** — this slice invents nothing.

**Exactly one entry: RCPT-R1.**

---

## §V. IMPLEMENTATION FILE PLAN

Nothing below was created or modified in this session.

### V.1 New files

| # | Path | Purpose | Est. |
|---|---|---|---|
| 1 | `src/modules/sales/orders/receipt.errors.ts` | `ReceiptNotAvailableError extends OrderStateError` → 422 with zero filter changes. Mirrors `fire.errors.ts` / `payment.errors.ts`. | ~20 |
| 2 | `src/modules/sales/receipt.views.ts` | Pure mappers: `toReceiptView(order, lines, payments)`, `deriveTaxPresentation(totals)`. No Prisma client, no Nest, no HTTP. Mirrors `sales.views.ts`. | ~150 |
| 3 | `src/modules/sales/receipt.views.spec.ts` | Focused unit spec (§R.3) | ~180 |
| 4 | `src/modules/sales/orders/receipt.service.ts` | `ReceiptService.findCompletedOrderReceipt(tenantId, id, businessDay)` — RLS-scoped `withAuthContext`, 3 reads, eligibility check, delegate to the view. **`AuditService` deliberately NOT injected.** | ~110 |
| 5 | `src/modules/sales/orders/receipt.openapi.ts` | `receiptSchema` constant. A separate file because `orders.controller.ts` is already 901 lines. | ~130 |
| 6 | `test/receipt.e2e-spec.ts` | Scenarios A–P (§R.1) | ~700 |

### V.2 Modified files

| # | Path | Change | Est. |
|---|---|---|---|
| 7 | `src/modules/sales/orders/orders.controller.ts` | **One** `@Get(':businessDay/:id/receipt')` handler + decorators + `receiptSchema` import; header route-map comment gains one line | ~45 |
| 8 | `src/modules/sales/sales.module.ts` | `ReceiptService` added to `providers`. **No new module import.** Doc comment gains one PUBLIC-SURFACE line. | ~4 |
| 9 | `test/openapi.e2e-spec.ts` | One `receiptMatches` assertion inside the existing route-surface `it` (§R.4) | ~4 |
| 10 | `docs/api/openapi.json` | Regenerated | auto |
| 11 | `docs/api/openapi.yaml` | Regenerated | auto |
| 12 | `docs/governance/GOVERNANCE_DECISION_REGISTER.md` | **Append** the RCPT-R1 section (§U.2). **Append only** — `git diff` must show **0 removed lines**. | ~60 |
| 13 | `docs/reports/claude/<date>_INTERNAL-MVP-receipt-implementation.md` | New implementation report | — |
| 14 | `docs/reports/claude/INDEX.md` | **One** appended row | 1 |

### V.3 Files NOT touched — stated so the diff can be reviewed against it

```
prisma/schema.prisma                          NOT MODIFIED
prisma/migrations/**                          NOT MODIFIED (35, unchanged)
src/modules/sales/sales.permissions.ts        NOT MODIFIED (no new permission)
src/modules/sales/orders/order-state.ts       NOT MODIFIED
src/modules/sales/orders/order-lines.service.ts        NOT MODIFIED
src/modules/sales/orders/sales-payment.service.ts      NOT MODIFIED
src/modules/sales/sales-domain-exception.filter.ts     NOT MODIFIED
src/modules/sales/sales.views.ts              NOT MODIFIED
src/modules/sales/contract/**                 NOT MODIFIED (nothing consumes this)
src/modules/module-boundaries.spec.ts         NOT MODIFIED (45/45)
src/modules/localisation/**                   NOT MODIFIED
src/modules/organisation/**                   NOT MODIFIED
src/modules/treasury/**                       NOT MODIFIED
src/modules/reporting/**                      NOT MODIFIED
src/common/openapi/schema-helpers.ts          NOT MODIFIED
src/common/openapi/oas31.util.ts              NOT MODIFIED
```

### V.4 Summary declaration

```
NEW TABLES:        NONE
NEW MIGRATIONS:    NONE
NEW DOMAIN EVENTS: NONE
NEW AUDIT ACTIONS: NONE
NEW PERMISSIONS:   NONE
```

---

## §W. ACCEPTANCE GATE — INTERNAL MVP EXIT CONTRACT FOR RECEIPT

### W.1 The 15 conditions (§19), each mapped to its proof

| # | Condition | Proof | Verdict |
|---|---|---|---|
| 1 | Create/order flow succeeds | Pre-existing, accepted | Fixture |
| 2 | Order is paid/completed | Pre-existing, accepted (P1F-1/P1F-2) | Fixture |
| 3 | Receipt GET returns 200 | Tests A, B | Designed |
| 4 | Receipt identifies the exact order | `order.id` + `orderNumber` + `businessDay` + `branchId` (§G.2) | Designed |
| 5 | All existing completed lines accurate | Test D + §G.3 | Designed |
| 6 | Totals equal finalized order totals | Test E — exact `BigInt` equality (§H.6) | Designed |
| 7 | Tax equals finalized stored tax facts | Test E | Designed |
| 8 | Tender summary matches finalized payments | Tests A, B, C | Designed |
| 9 | Historical receipt stable after Catalogue edits | **Test G** — item + variant + modifier all renamed post-completion | Designed |
| 10 | Visibly/machine-readably NON-FISCAL | §L — `documentType` + `fiscal:false` + `disclosureKey`; asserted in A/B and the unit spec | Designed |
| 11 | Unauthorized / other-tenant access fails | Tests L, M — 404 / 403 / 401 | Designed |
| 12 | Non-completed order cannot produce a final receipt | Tests I, J, K — 422 | Designed |
| 13 | OpenAPI schema complete | §Q.3 (nine existing assertions) + §R.4 | Designed |
| 14 | No DB mutation on GET | **Test P** — version, `updated_at` and audit-row count unchanged across 3 GETs | Designed |
| 15 | Existing regressions remain zero | §W.2 | Gate |

### W.2 Regression bar (§21)

| Gate | Baseline (user-declared) | Expected after |
|---|---|---|
| Dedicated receipt e2e | — | **A–P all pass** |
| Unit | 797/797 | 797 + new `receipt.views.spec.ts` cases, **100%** |
| Module boundaries | 45/45 | **45/45 — unchanged, zero new `KNOWN_DEVIATIONS`** |
| OpenAPI suite | 46/46 | **46/46** (existing `it` extended, not added) |
| Full e2e (fresh scratch DB) | 1134/1134, 63/63 suites | 1134 + receipt suite, 64 suites, **100%** |
| Migrations from zero | 35/35 | **35/35 — unchanged** |
| Lint | — | **0 new errors, 0 new warnings** |
| TSC | 1 pre-existing error | **1 pre-existing, 0 new** |
| `git diff --check` | clean | **clean** |
| `prisma validate` | passes | **passes** (schema untouched) |
| Nest build | passes | **passes** |
| OpenAPI regeneration | idempotent | **idempotent (byte-identical on re-run)** |

**Hard rule:** if the module-boundary suite reports anything other than 45/45,
or `KNOWN_DEVIATIONS` grows by even one entry, the implementation has departed
from this design and must stop.

---

## §X. REMAINING INTERNAL-MVP BLOCKERS

### X.1 Statement

> **Receipt is the final known feature slice before the Internal-MVP Exit
> Gate.**

No other unimplemented capability was identified this session as blocking the
controlled single-branch Internal MVP. The most recent state audit
(`2026-09-01_INTERNAL-MVP-current-state.md`) listed **exactly two** open edges —
DayClose and Receipt. DayClose is **FINAL ACCEPTED and source-control closed**
at `02fd05a`, carried into this HEAD.

### X.2 What this statement does NOT say

- It does **not** say the Internal MVP is complete (§24 of the task).
- It does **not** say the receipt is implemented — nothing was implemented here.
- It does **not** say the exit audit will pass.

Completion requires, in order: **implementation → acceptance → source-control
closure → final Internal-MVP exit audit.** This report is upstream of all four.

### X.3 Known non-blocking gaps, restated for the exit audit

Carried from prior accepted reports, **not re-audited in depth this session**:

| Gap | Status | Blocking Internal MVP? |
|---|---|---|
| Full fiscal receipt (FR-POS-100 fiscal limbs, 101–106) | NOT IMPLEMENTED — P1C-1 | **NO** — after RCPT-R1 |
| Printing / spooler / retry (FR-POS-106) | NOT IMPLEMENTED | **NO** — §14 boundary |
| Digital delivery (FR-POS-103) | NOT IMPLEMENTED | **NO** |
| Reprint marking + log (FR-POS-104 `[S]`) | NOT IMPLEMENTED | **NO** — Internal-MVP reprint = re-GET |
| Discounts (BR-FIN-003) | NOT IMPLEMENTED | **NO** |
| Service charge (FR-POS-055 `[S]`), tips (FR-POS-056 `[S]`) | NOT IMPLEMENTED | **NO** |
| Refunds | NOT IMPLEMENTED | **NO** |
| Comp (FR-POS-050 `[S]`) | NOT IMPLEMENTED | **NO** |
| Automatic DayClose (FR-FIN-025 `[S]`) | NOT IMPLEMENTED | **NO** |
| Branch-scoped RBAC (D-2) | Ratified core-only carve-out | **NO** |
| Offline / Sync | NOT IMPLEMENTED | **NO** — Internal MVP is online-only |
| Two pre-existing OpenAPI type defects (§Q.4) | Documentation-only | **NO** — worth a follow-up slice |

### X.4 The printing boundary — stated explicitly (§14)

> **The Internal-MVP acceptance target is A: receipt DATA / VIEW capability.**
>
> **B — physical printer integration — is NOT the target and does NOT gate the
> Internal-MVP exit.**

No existing source provides a trivial safe print path: there is **no** print
job, spooler, queue, driver or printer-health code anywhere in `src/`. The only
printing-adjacent model is `PrintRouting` (schema L791), which is Organisation
**routing configuration**, not a print pipeline.

No SRS or Internal-MVP authority was found requiring physical paper output for
this exit gate. FR-POS-100's verb "print" is [M] **for the product**, and its
print limb stays NOT IMPLEMENTED inside the PARTIAL classification (§A.3).

**The client renders and prints the returned document using normal browser or
device printing, entirely outside backend state management.** The backend
neither knows nor records that a physical print occurred — which is also why
there is no reprint counter (§P.2) and no audit write (§P.4).

---

## §Y. SUMMARY OF EVERY DECISION MADE

| Question | Decision | Section |
|---|---|---|
| Owner module | **Sales** | §D |
| Route | **`GET /orders/{businessDay}/{id}/receipt`** | §E |
| Method | **GET** (no POST justified or proposed) | §E.2 |
| Permission | **`pos.order.create`** reused; `pos.reprint.receipt` deliberately not adopted | §F |
| Eligibility | **`completed` only**; everything else 422 | §O |
| Line set | `state NOT IN ('voided','comped')` — the totals filter, copied | §H.6 |
| Stored vs projection | **Read-only projection** | §P |
| Migration | **NO** | §P.1 |
| Persistence | **NONE** | §P.1 |
| Sequence | **NONE** | §P.2 |
| Audit | **NO WRITE**; `AuditService` not injected | §P.4 |
| Domain event | **NONE** | §P.5 |
| Cross-module dependency | **NONE** | §N |
| Tax breakdown by class | **EXCLUDED** — an FR-POS-100 fiscal element | §J.5 |
| `taxPresentation` | **INCLUDED** — derived from the frozen order row only (FR-FIN-031) | §J.2 |
| Cash rounding | **INCLUDED**, named `cashRoundingAdjustment`, never in totals | §J.4 |
| Payments | **Per-payment entries**, no derived roll-up | §I.2 |
| Card data | `cardScheme` + `cardLast4` only | §I.4 |
| Branch name / logo | **EXCLUDED** — mutable master data + FR-POS-101 concern | §K.5 |
| `generatedAt` | **ABSENT** — enables byte-identical reprint | §K.4 |
| ETag | **NOT emitted** | §K.6 |
| Non-fiscal marker | `documentType` + `fiscal:false` + `disclosureKey` | §L |
| Non-completed order status | **422** (repo's own filter convention) | §M.2 |
| Cross-tenant status | **404** (never 403) | §F.3 |
| Printing | **Out of scope**; client-side rendering | §X.4 |
| Reprint | **Re-GET**; no counter, table, event or log | §L, §P.2 |
| Governance | **RCPT-R1 only** | §U |
| P1C-1 | **Not reopened; still blocks full fiscal receipt** | §T |
| FR-POS-100 | **NOT IMPLEMENTED → PARTIAL** | §A.3 |
| FR-POS-101…106 | **Unchanged** | §S |

---

## §Z. VERDICT

> # **A. RECEIPT DESIGN ACCEPTED-READY — IMPLEMENTATION CAN START**

**Preconditions for the implementation run:**

1. Record **RCPT-R1** in `docs/governance/GOVERNANCE_DECISION_REGISTER.md`
   (append-only, §U.2). This may be done by the implementation run or as a
   separate governance-recording task, but **must** precede acceptance.
2. Implement exactly §V. Any departure — a table, a migration, a permission, a
   cross-module import, a persisted document, an audit write, an added scope
   field — **invalidates this gate** and requires a new one.
3. Meet §W in full. 45/45 boundaries and 35/35 migrations are **hard** gates.

**Nothing in this report ratifies anything, and nothing in it has been
implemented.**
