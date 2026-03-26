# Key Tables & Relationships

Quick reference for the most-queried tables in the system.

## Core Entities

| Table | Primary Key | Description | Key Columns |
|-------|-------------|-------------|-------------|
| `unified_contacts` | `id` (uuid) | All contacts (individuals + companies) | `full_name`, `email`, `lifecycle_stage`, `contact_kind` |
| `unified_products` | `id` (uuid) | Product catalog | `name`, `product_number` (SKU), `furniture_type`, `list_price`, `cost` |
| `orders` | `id` (uuid) | Sales orders | `order_number`, `status`, `total_amount`, `contact_id` |
| `proposals` | `id` (uuid) | Sales proposals | `proposal_number`, `status`, `total_amount`, `contact_id` |
| `unified_documents` | `id` (uuid) | All documents (polymorphic) | `title`, `document_type`, `primary_entity_type`, `primary_entity_id` |
| `user_profiles` | `id` (uuid) | Internal users | `full_name`, `email`, `user_type`, `role` |

## Relationships

```
unified_contacts ─┬─< orders (contact_id)
                  ├─< proposals (contact_id)
                  └─< unified_documents (primary_entity_id WHERE primary_entity_type = 'contact')

unified_products ─┬─< order_line_items (unified_product_id)
                  ├─< proposal_items (unified_product_id)
                  ├─< furniture_dimensions (unified_product_id)
                  ├─< product_images (unified_product_id)
                  └─< unified_documents (primary_entity_id WHERE primary_entity_type = 'product')

orders ─────────── order_line_items (order_id)
proposals ──────── proposal_sections ─── proposal_items
```

## Known Column Gotchas

| Table | WRONG Column | CORRECT Column |
|-------|--------------|----------------|
| `design_*` tables | `project_id` | `design_project_id` |
| `unified_products` | `category` | `furniture_type` |
| `unified_products` | `retail_price` | `list_price` |
| `unified_products` | `unit_cost` | `cost` |
| `unified_products` | `sku` | `product_number` (sku is NULL) |

## ALWAYS Verify Schema First

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'YOUR_TABLE'
ORDER BY ordinal_position;
```
