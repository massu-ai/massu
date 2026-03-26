# Common Queries

Pre-built query templates for frequent data analysis tasks.

## Entity Counts

```sql
SELECT 'contacts' as entity, COUNT(*) as count FROM unified_contacts
UNION ALL SELECT 'products', COUNT(*) FROM unified_products
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'proposals', COUNT(*) FROM proposals
UNION ALL SELECT 'documents', COUNT(*) FROM unified_documents
UNION ALL SELECT 'users', COUNT(*) FROM user_profiles
ORDER BY count DESC;
```

## Recent Activity (Last 7 Days)

```sql
SELECT 'contacts_created' as metric, COUNT(*) as count
FROM unified_contacts WHERE created_at > NOW() - INTERVAL '7 days'
UNION ALL
SELECT 'orders_created', COUNT(*)
FROM orders WHERE created_at > NOW() - INTERVAL '7 days'
UNION ALL
SELECT 'proposals_created', COUNT(*)
FROM proposals WHERE created_at > NOW() - INTERVAL '7 days'
UNION ALL
SELECT 'documents_uploaded', COUNT(*)
FROM unified_documents WHERE created_at > NOW() - INTERVAL '7 days';
```

## Contact Lifecycle Funnel

```sql
SELECT lifecycle_stage, COUNT(*) as count,
  ROUND(COUNT(*)::numeric / SUM(COUNT(*)) OVER () * 100, 1) as pct
FROM unified_contacts
WHERE lifecycle_stage IS NOT NULL
GROUP BY lifecycle_stage
ORDER BY CASE lifecycle_stage
  WHEN 'lead' THEN 1
  WHEN 'prospect' THEN 2
  WHEN 'customer' THEN 3
  WHEN 'repeat' THEN 4
  ELSE 5
END;
```

## Order Status Distribution

```sql
SELECT status, COUNT(*) as count,
  SUM(COALESCE(total_amount, 0))::float as total_value
FROM orders
GROUP BY status
ORDER BY count DESC;
```

## Top Products by Order Frequency

```sql
SELECT up.product_number as sku, up.name, COUNT(oli.id) as order_count
FROM order_line_items oli
JOIN unified_products up ON up.id = oli.unified_product_id
GROUP BY up.id, up.product_number, up.name
ORDER BY order_count DESC
LIMIT 20;
```

## Storage Bucket Usage

```sql
SELECT bucket_id, COUNT(*) as file_count,
  SUM(COALESCE((metadata->>'size')::bigint, 0))::float as total_bytes
FROM storage.objects
GROUP BY bucket_id
ORDER BY total_bytes DESC;
```
