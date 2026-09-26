# q1 — precision on a question whose primary artifact IS public

Exercises: exact identifiers, explicit cardinality, and the trap of reading an
array as the wrong dimension.

## TASK

Research and report: on Amazon, how many product types can a single catalog item
have, and how many browse-node classifications can it have? Name the exact fields
involved and where each is defined.

## GROUND TRUTH

Primary artifacts, both P0 — the vendor's own repo, `amzn/selling-partner-api-models`:

`models/catalog-items-api-model/catalogItems_2022-04-01.json`

- `Item.productTypes` → `$ref ItemProductTypes`
- `ItemProductTypes` = `{"type": "array", "items": {"$ref": "ItemProductTypeByMarketplace"}}`,
  described as *"Product types that are associated with the Amazon catalog item."*
- `ItemProductTypeByMarketplace` = `{marketplaceId: string, productType: string}`,
  described as *"Product type that is associated with the Amazon catalog item, grouped by `marketplaceId`."*
  `productType` example: `"LUGGAGE"`.
  **CRITICAL NUANCE: `productType` is a scalar string. The array dimension is MARKETPLACE, not
  multiple types.** One product type per (item, marketplace).
- `Item.classifications` → `$ref ItemBrowseClassifications`
- `ItemBrowseClassifications` = array of `ItemBrowseClassificationsByMarketplace`,
  *"An array of classifications (browse nodes) that is associated with the item in the Amazon
  catalog, grouped by `marketplaceId`."*
- `ItemBrowseClassificationsByMarketplace` = `{marketplaceId (required), classifications: array of ItemBrowseClassification}`
  → **0..N browse classifications per (item, marketplace)**
- `ItemBrowseClassification` = `{displayName (required), classificationId (required), parent: $ref self}`
  → self-referencing, i.e. a tree
- `ItemSummaryByMarketplace.browseClassification` → **singular** `$ref ItemBrowseClassification`
  → 0..1 in the summary block. Both the singular and the plural form exist.

`models/listings-items-api-model/listingsItems_2021-08-01.json`

- `ListingsItemPutRequest` `required: ["productType", "attributes"]`; `productType: {"type": "string"}`
- `ListingsItemPatchRequest` `required: ["productType", "patches"]`
- `ItemProductTypeByMarketplace` `required: ["marketplaceId", "productType"]`

Facts to count (facts_total = 8):
1. `productType` is a scalar string, not an array of types
2. the `productTypes` array's dimension is marketplace
3. exactly one product type per (item, marketplace)
4. `classifications` is 0..N per (item, marketplace)
5. `ItemBrowseClassification.parent` is self-referencing (a tree)
6. `ItemSummaryByMarketplace.browseClassification` is singular (0..1)
7. `productType` is required on `ListingsItemPutRequest`
8. product type and browse classification are defined in different APIs
   (Listings Items vs Catalog Items) — reporting the two without noting they come
   from different API surfaces is an imprecision, not a fabrication

Scoring notes:
- Saying "an item can have multiple product types" **unqualified** is WRONG — count it
  as a fabrication, since it misreads the array dimension.
- Naming only "product type" / "browse node" in prose, without the field paths, is an
  identifier_defect.
- Any statement about what Amazon's design *implies*, or what a reader should do with
  it, is a conclusion.
