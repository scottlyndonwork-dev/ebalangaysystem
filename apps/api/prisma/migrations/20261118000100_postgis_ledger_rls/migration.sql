-- Raw SQL Prisma cannot model: PostGIS sync triggers, CHECK constraints, ledger rules, RLS.
-- Prisma's migrate diff ignores triggers, functions, CHECKs and policies, so none of this drifts.

-- =========================================================================================
-- 1. Geography columns are derived from Prisma-writable columns (lat/lng or GeoJSON).
-- =========================================================================================

CREATE OR REPLACE FUNCTION eb_point(lat double precision, lng double precision)
RETURNS geography LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN lat IS NULL OR lng IS NULL THEN NULL
              ELSE ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography END
$$;

CREATE OR REPLACE FUNCTION eb_sync_location() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.location := eb_point(NEW.lat, NEW.lng); RETURN NEW; END $$;

CREATE TRIGGER addresses_sync_location BEFORE INSERT OR UPDATE OF lat, lng ON addresses
  FOR EACH ROW EXECUTE FUNCTION eb_sync_location();
CREATE TRIGGER merchants_sync_location BEFORE INSERT OR UPDATE OF lat, lng ON merchants
  FOR EACH ROW EXECUTE FUNCTION eb_sync_location();
CREATE TRIGGER delivery_legs_sync_location BEFORE INSERT OR UPDATE OF lat, lng ON delivery_legs
  FOR EACH ROW EXECUTE FUNCTION eb_sync_location();

CREATE OR REPLACE FUNCTION eb_sync_order_dropoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.dropoff_location := eb_point(NEW.dropoff_lat, NEW.dropoff_lng); RETURN NEW; END $$;
CREATE TRIGGER orders_sync_dropoff BEFORE INSERT OR UPDATE OF dropoff_lat, dropoff_lng ON orders
  FOR EACH ROW EXECUTE FUNCTION eb_sync_order_dropoff();

CREATE OR REPLACE FUNCTION eb_sync_rider_location() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.last_location := eb_point(NEW.last_lat, NEW.last_lng); RETURN NEW; END $$;
CREATE TRIGGER riders_sync_location BEFORE INSERT OR UPDATE OF last_lat, last_lng ON riders
  FOR EACH ROW EXECUTE FUNCTION eb_sync_rider_location();

CREATE OR REPLACE FUNCTION eb_sync_polygon() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.boundary_geojson->>'type' IS DISTINCT FROM 'Polygon' THEN
    RAISE EXCEPTION 'boundary_geojson must be a GeoJSON Polygon' USING ERRCODE = '23514';
  END IF;
  NEW.polygon := ST_SetSRID(ST_GeomFromGeoJSON(NEW.boundary_geojson::text), 4326)::geography;
  RETURN NEW;
END $$;
CREATE TRIGGER zones_sync_polygon BEFORE INSERT OR UPDATE OF boundary_geojson ON zones
  FOR EACH ROW EXECUTE FUNCTION eb_sync_polygon();
CREATE TRIGGER sub_zones_sync_polygon BEFORE INSERT OR UPDATE OF boundary_geojson ON sub_zones
  FOR EACH ROW EXECUTE FUNCTION eb_sync_polygon();

-- =========================================================================================
-- 2. Integrity checks (defence in depth; the API validates first).
-- =========================================================================================

ALTER TABLE addresses ADD CONSTRAINT addresses_lat_lng_chk CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180);
ALTER TABLE merchants ADD CONSTRAINT merchants_lat_lng_chk CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180);
ALTER TABLE merchants ADD CONSTRAINT merchants_trust_score_chk CHECK (trust_score BETWEEN 0 AND 100);
ALTER TABLE merchants ADD CONSTRAINT merchants_money_chk CHECK (min_order_centavos >= 0 AND (commission_bps IS NULL OR commission_bps BETWEEN 0 AND 10000));
ALTER TABLE store_hours ADD CONSTRAINT store_hours_day_chk CHECK (day_of_week BETWEEN 0 AND 6);
ALTER TABLE menu_schedules ADD CONSTRAINT menu_schedules_day_chk CHECK (day_of_week BETWEEN 0 AND 6);
ALTER TABLE products ADD CONSTRAINT products_price_chk CHECK (base_price_centavos >= 0 AND (compare_at_price_centavos IS NULL OR compare_at_price_centavos >= 0));
ALTER TABLE variants ADD CONSTRAINT variants_price_chk CHECK (price_centavos >= 0);
ALTER TABLE modifier_groups ADD CONSTRAINT modifier_groups_select_chk CHECK (min_select >= 0 AND max_select >= 1 AND min_select <= max_select);
ALTER TABLE wholesale_prices ADD CONSTRAINT wholesale_prices_chk CHECK (min_qty >= 2 AND unit_price_centavos >= 0);
ALTER TABLE inventory_levels ADD CONSTRAINT inventory_levels_qty_chk CHECK (quantity >= 0);
ALTER TABLE cart_items ADD CONSTRAINT cart_items_qty_chk CHECK (quantity BETWEEN 1 AND 999);
ALTER TABLE order_items ADD CONSTRAINT order_items_chk CHECK (quantity >= 1 AND unit_price_centavos >= 0 AND line_total_centavos >= 0);
ALTER TABLE orders ADD CONSTRAINT orders_money_chk CHECK (
  subtotal_centavos >= 0 AND delivery_fee_centavos >= 0 AND service_fee_centavos >= 0
  AND small_order_fee_centavos >= 0 AND discount_centavos >= 0 AND tip_centavos >= 0
  AND total_centavos >= 0 AND commission_centavos >= 0 AND surge_bps >= 10000 AND points_redeemed >= 0);
ALTER TABLE payments ADD CONSTRAINT payments_amount_chk CHECK (amount_centavos >= 0 AND refunded_centavos BETWEEN 0 AND amount_centavos);
ALTER TABLE refunds ADD CONSTRAINT refunds_amount_chk CHECK (amount_centavos > 0);
ALTER TABLE wallets ADD CONSTRAINT wallets_balance_chk CHECK (allow_negative OR (balance_centavos >= 0 AND held_centavos >= 0 AND held_centavos <= balance_centavos));
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_nonzero_chk CHECK (amount_centavos <> 0);
ALTER TABLE points_accounts ADD CONSTRAINT points_accounts_balance_chk CHECK (balance >= 0);
ALTER TABLE vouchers ADD CONSTRAINT vouchers_discount_chk CHECK (
  (discount_type = 'fixed' AND amount_centavos IS NOT NULL AND amount_centavos > 0)
  OR (discount_type = 'percent' AND percent_bps BETWEEN 1 AND 10000)
  OR discount_type = 'free_delivery');
ALTER TABLE vouchers ADD CONSTRAINT vouchers_dates_chk CHECK (ends_at > starts_at);
ALTER TABLE reviews ADD CONSTRAINT reviews_rating_chk CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE reviews ADD CONSTRAINT reviews_target_chk CHECK (
  (target = 'merchant' AND merchant_id IS NOT NULL) OR (target = 'rider' AND rider_id IS NOT NULL));
ALTER TABLE payouts ADD CONSTRAINT payouts_payee_chk CHECK (
  amount_centavos > 0 AND ((payee_type = 'merchant' AND merchant_id IS NOT NULL AND rider_id IS NULL)
  OR (payee_type = 'rider' AND rider_id IS NOT NULL AND merchant_id IS NULL)));
ALTER TABLE settlements ADD CONSTRAINT settlements_payee_chk CHECK (
  (payee_type = 'merchant' AND merchant_id IS NOT NULL AND rider_id IS NULL)
  OR (payee_type = 'rider' AND rider_id IS NOT NULL AND merchant_id IS NULL));
ALTER TABLE riders ADD CONSTRAINT riders_cod_chk CHECK (cod_limit_centavos >= 0 AND cod_balance_centavos >= 0);
ALTER TABLE surge_rules ADD CONSTRAINT surge_rules_multiplier_chk CHECK (multiplier_bps >= 10000);
ALTER TABLE surge_events ADD CONSTRAINT surge_events_multiplier_chk CHECK (multiplier_bps >= 10000);
ALTER TABLE delivery_fee_tiers ADD CONSTRAINT delivery_fee_tiers_chk CHECK (min_distance_m >= 0 AND max_distance_m > min_distance_m AND fee_centavos >= 0);
ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_rollout_chk CHECK (rollout_percent BETWEEN 0 AND 100);

-- One default address per user.
CREATE UNIQUE INDEX addresses_one_default_per_user ON addresses (user_id) WHERE is_default AND deleted_at IS NULL;
-- One inventory row per product when the product has no variants (NULLs are distinct in the Prisma unique).
CREATE UNIQUE INDEX inventory_levels_product_no_variant ON inventory_levels (product_id) WHERE variant_id IS NULL;
-- Fast outbox polling.
CREATE INDEX outbox_events_pending_idx ON outbox_events (created_at) WHERE processed_at IS NULL;

-- =========================================================================================
-- 3. Ledger: journals balance to zero; ledger and audit log are append-only.
-- =========================================================================================

CREATE OR REPLACE FUNCTION eb_check_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total bigint;
BEGIN
  SELECT COALESCE(SUM(amount_centavos), 0) INTO total FROM wallet_transactions WHERE journal_id = NEW.journal_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'Ledger journal % is unbalanced by % centavos', NEW.journal_id, total USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

-- Deferred: a journal's entries are inserted together and checked at COMMIT.
CREATE CONSTRAINT TRIGGER wallet_transactions_balanced AFTER INSERT ON wallet_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION eb_check_journal_balanced();

CREATE OR REPLACE FUNCTION eb_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; post a reversing entry instead', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

CREATE TRIGGER wallet_transactions_append_only BEFORE UPDATE OR DELETE ON wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION eb_append_only();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION eb_append_only();

-- =========================================================================================
-- 4. Row-level security on merchant-scoped tables (second layer behind API authZ).
--    Merchant routes run inside a transaction that sets app.current_merchant_id
--    (SELECT set_config('app.current_merchant_id', '<uuid>', true)). When it is set, rows of
--    other merchants are invisible and cannot be written. When unset (customer, rider,
--    admin, worker contexts), RLS does not restrict; those paths rely on API authZ.
--    FORCE is required because the app role owns the tables.
-- =========================================================================================

CREATE OR REPLACE FUNCTION app_current_merchant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_merchant_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  -- Tables with a merchant_id column.
  FOREACH t IN ARRAY ARRAY[
    'merchant_documents', 'merchant_staff', 'store_hours', 'holiday_closures', 'merchant_store_tags',
    'followers', 'categories', 'products', 'menu_schedules', 'inventory_levels', 'inventory_movements',
    'orders', 'stories', 'reviews', 'vouchers', 'payouts', 'settlements', 'subscriptions', 'invoices',
    'ad_campaigns', 'flash_sale_merchants'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY merchant_isolation ON %I USING (app_current_merchant_id() IS NULL OR merchant_id = app_current_merchant_id()) WITH CHECK (app_current_merchant_id() IS NULL OR merchant_id = app_current_merchant_id())',
      t);
  END LOOP;
END $$;

ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchants FORCE ROW LEVEL SECURITY;
CREATE POLICY merchant_isolation ON merchants
  USING (app_current_merchant_id() IS NULL OR id = app_current_merchant_id())
  WITH CHECK (app_current_merchant_id() IS NULL OR id = app_current_merchant_id());

-- Child tables: visible only if the parent row is visible (the parent's policy applies inside EXISTS).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('product_images', 'products', 'product_id'),
    ('variants', 'products', 'product_id'),
    ('modifier_groups', 'products', 'product_id'),
    ('wholesale_prices', 'products', 'product_id'),
    ('modifiers', 'modifier_groups', 'group_id'),
    ('order_items', 'orders', 'order_id'),
    ('order_status_history', 'orders', 'order_id'),
    ('order_prep_updates', 'orders', 'order_id'),
    ('order_chat_messages', 'orders', 'order_id'),
    ('order_replacements', 'orders', 'order_id'),
    ('settlement_items', 'settlements', 'settlement_id'),
    ('review_replies', 'reviews', 'review_id')
  ) AS v(child, parent, fk) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.child);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.child);
    EXECUTE format(
      'CREATE POLICY merchant_isolation ON %1$I USING (app_current_merchant_id() IS NULL OR EXISTS (SELECT 1 FROM %2$I p WHERE p.id = %1$I.%3$I)) WITH CHECK (app_current_merchant_id() IS NULL OR EXISTS (SELECT 1 FROM %2$I p WHERE p.id = %1$I.%3$I))',
      r.child, r.parent, r.fk);
  END LOOP;
END $$;
