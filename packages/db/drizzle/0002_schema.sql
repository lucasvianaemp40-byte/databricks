CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TABLE "app"."appointment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "appointment_events_type_valid" CHECK ("app"."appointment_events"."event_type" IN ('created', 'status_changed')),
	CONSTRAINT "appointment_events_from_status_valid" CHECK ("app"."appointment_events"."from_status" IN ('pending', 'confirmed', 'checked_in', 'in_service', 'completed', 'cancelled_by_customer', 'cancelled_by_salon', 'no_show', 'expired')),
	CONSTRAINT "appointment_events_to_status_valid" CHECK ("app"."appointment_events"."to_status" IN ('pending', 'confirmed', 'checked_in', 'in_service', 'completed', 'cancelled_by_customer', 'cancelled_by_salon', 'no_show', 'expired')),
	CONSTRAINT "appointment_events_from_status_shape" CHECK (("app"."appointment_events"."event_type" = 'created') = ("app"."appointment_events"."from_status" IS NULL)),
	CONSTRAINT "appointment_events_actor_type_valid" CHECK ("app"."appointment_events"."actor_type" IN ('customer', 'staff', 'system', 'unknown')),
	CONSTRAINT "appointment_events_actor_id_length" CHECK (char_length("app"."appointment_events"."actor_id") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "app"."appointment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"service_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"service_name" text NOT NULL,
	"duration_min" smallint NOT NULL,
	"phases" jsonb NOT NULL,
	"price_cents" integer NOT NULL,
	"commission_bps" integer NOT NULL,
	"buffer_before_min" smallint DEFAULT 0 NOT NULL,
	"buffer_after_min" smallint DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointment_items_tenant_appointment_id_staff_key" UNIQUE("tenant_id","appointment_id","id","staff_id"),
	CONSTRAINT "appointment_items_tenant_appointment_position_key" UNIQUE("tenant_id","appointment_id","position"),
	CONSTRAINT "appointment_items_position_range" CHECK ("app"."appointment_items"."position" BETWEEN 1 AND 50),
	CONSTRAINT "appointment_items_service_name_length" CHECK (char_length("app"."appointment_items"."service_name") BETWEEN 1 AND 120),
	CONSTRAINT "appointment_items_duration_range" CHECK ("app"."appointment_items"."duration_min" BETWEEN 5 AND 720),
	CONSTRAINT "appointment_items_phases_valid" CHECK (app_private.service_phases_are_valid("app"."appointment_items"."phases", "app"."appointment_items"."duration_min")),
	CONSTRAINT "appointment_items_duration_coherent" CHECK ("app"."appointment_items"."ends_at" - "app"."appointment_items"."starts_at" = make_interval(mins => "app"."appointment_items"."duration_min")),
	CONSTRAINT "appointment_items_price_range" CHECK ("app"."appointment_items"."price_cents" BETWEEN 0 AND 100000000),
	CONSTRAINT "appointment_items_commission_range" CHECK ("app"."appointment_items"."commission_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "appointment_items_time_order" CHECK ("app"."appointment_items"."ends_at" > "app"."appointment_items"."starts_at"),
	CONSTRAINT "appointment_items_instant_precision" CHECK (date_trunc('milliseconds', "app"."appointment_items"."starts_at") = "app"."appointment_items"."starts_at" AND date_trunc('milliseconds', "app"."appointment_items"."ends_at") = "app"."appointment_items"."ends_at"),
	CONSTRAINT "appointment_items_buffer_before_range" CHECK ("app"."appointment_items"."buffer_before_min" BETWEEN 0 AND 240),
	CONSTRAINT "appointment_items_buffer_after_range" CHECK ("app"."appointment_items"."buffer_after_min" BETWEEN 0 AND 240)
);
--> statement-breakpoint
CREATE TABLE "app"."appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"local_starts_at" timestamp NOT NULL,
	"local_utc_offset_seconds" integer NOT NULL,
	"timezone" text NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"checked_in_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"no_show_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"cancellation_reason" text,
	"idempotency_key" text NOT NULL,
	"rescheduled_from_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointments_tenant_idempotency_key_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "appointments_status_valid" CHECK ("app"."appointments"."status" IN ('pending', 'confirmed', 'checked_in', 'in_service', 'completed', 'cancelled_by_customer', 'cancelled_by_salon', 'no_show', 'expired')),
	CONSTRAINT "appointments_source_valid" CHECK ("app"."appointments"."source" IN ('online', 'staff', 'walk_in')),
	CONSTRAINT "appointments_time_order" CHECK ("app"."appointments"."ends_at" > "app"."appointments"."starts_at"),
	CONSTRAINT "appointments_max_length" CHECK ("app"."appointments"."ends_at" - "app"."appointments"."starts_at" <= interval '24 hours'),
	CONSTRAINT "appointments_instant_precision" CHECK (date_trunc('milliseconds', "app"."appointments"."starts_at") = "app"."appointments"."starts_at" AND date_trunc('milliseconds', "app"."appointments"."ends_at") = "app"."appointments"."ends_at"),
	CONSTRAINT "appointments_timezone_valid" CHECK (app_private.is_valid_iana_timezone("app"."appointments"."timezone")),
	CONSTRAINT "appointments_utc_offset_range" CHECK ("app"."appointments"."local_utc_offset_seconds" BETWEEN -64800 AND 64800),
	CONSTRAINT "appointments_local_time_coherent" CHECK ("app"."appointments"."local_starts_at" = date_trunc('second', ("app"."appointments"."starts_at" AT TIME ZONE 'UTC') + make_interval(secs => "app"."appointments"."local_utc_offset_seconds"))),
	CONSTRAINT "appointments_pending_requires_hold" CHECK ("app"."appointments"."status" <> 'pending' OR "app"."appointments"."hold_expires_at" IS NOT NULL),
	CONSTRAINT "appointments_idempotency_key_format" CHECK ("app"."appointments"."idempotency_key" ~ '^[A-Za-z0-9._:-]{8,128}$'),
	CONSTRAINT "appointments_cancellation_reason_length" CHECK (char_length("app"."appointments"."cancellation_reason") BETWEEN 1 AND 500),
	CONSTRAINT "appointments_version_positive" CHECK ("app"."appointments"."version" >= 1),
	CONSTRAINT "appointments_not_rescheduled_from_self" CHECK ("app"."appointments"."rescheduled_from_id" <> "app"."appointments"."id")
);
--> statement-breakpoint
CREATE TABLE "app"."occupancies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"appointment_item_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"kind" text DEFAULT 'service' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"during" "tstzrange" GENERATED ALWAYS AS (tstzrange("starts_at", "ends_at", '[)')) STORED NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "occupancies_kind_valid" CHECK ("app"."occupancies"."kind" IN ('service', 'buffer')),
	CONSTRAINT "occupancies_time_order" CHECK ("app"."occupancies"."ends_at" > "app"."occupancies"."starts_at"),
	CONSTRAINT "occupancies_max_length" CHECK ("app"."occupancies"."ends_at" - "app"."occupancies"."starts_at" <= interval '24 hours'),
	CONSTRAINT "occupancies_instant_precision" CHECK (date_trunc('milliseconds', "app"."occupancies"."starts_at") = "app"."occupancies"."starts_at" AND date_trunc('milliseconds', "app"."occupancies"."ends_at") = "app"."occupancies"."ends_at")
);
--> statement-breakpoint
CREATE TABLE "app"."time_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"during" "tstzrange" GENERATED ALWAYS AS (tstzrange("starts_at", "ends_at", '[)')) STORED NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_off_kind_valid" CHECK ("app"."time_off"."kind" IN ('time_off', 'vacation', 'training', 'blocked')),
	CONSTRAINT "time_off_order" CHECK ("app"."time_off"."ends_at" > "app"."time_off"."starts_at"),
	CONSTRAINT "time_off_instant_precision" CHECK (date_trunc('milliseconds', "app"."time_off"."starts_at") = "app"."time_off"."starts_at" AND date_trunc('milliseconds', "app"."time_off"."ends_at") = "app"."time_off"."ends_at"),
	CONSTRAINT "time_off_max_length" CHECK ("app"."time_off"."ends_at" - "app"."time_off"."starts_at" <= interval '400 days'),
	CONSTRAINT "time_off_note_length" CHECK (char_length("app"."time_off"."note") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "app"."working_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"valid_from" date NOT NULL,
	"valid_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "working_hours_weekday_range" CHECK ("app"."working_hours"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "working_hours_time_order" CHECK ("app"."working_hours"."end_time" > "app"."working_hours"."start_time"),
	CONSTRAINT "working_hours_whole_minutes" CHECK (extract(second FROM "app"."working_hours"."start_time") = 0 AND extract(second FROM "app"."working_hours"."end_time") = 0),
	CONSTRAINT "working_hours_validity_order" CHECK ("app"."working_hours"."valid_until" IS NULL OR "app"."working_hours"."valid_until" >= "app"."working_hours"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "app"."customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"full_name" text NOT NULL,
	"phone_e164" text,
	"email" text,
	"whatsapp_opt_in_at" timestamp with time zone,
	"marketing_consent_at" timestamp with time zone,
	"privacy_notice_version" text,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "customers_full_name_length" CHECK (char_length("app"."customers"."full_name") BETWEEN 1 AND 120),
	CONSTRAINT "customers_phone_e164" CHECK ("app"."customers"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "customers_email_format" CHECK ("app"."customers"."email" = lower("app"."customers"."email") AND char_length("app"."customers"."email") <= 254 AND "app"."customers"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
	CONSTRAINT "customers_privacy_notice_version_length" CHECK (char_length("app"."customers"."privacy_notice_version") BETWEEN 1 AND 32),
	CONSTRAINT "customers_anonymized_without_contact" CHECK ("app"."customers"."anonymized_at" IS NULL OR ("app"."customers"."phone_e164" IS NULL AND "app"."customers"."email" IS NULL AND "app"."customers"."whatsapp_opt_in_at" IS NULL AND "app"."customers"."marketing_consent_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"phone_e164" text,
	"slot_interval_min" smallint DEFAULT 15 NOT NULL,
	"min_notice_min" integer DEFAULT 120 NOT NULL,
	"max_advance_days" integer DEFAULT 60 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "locations_tenant_id_slug_key" UNIQUE("tenant_id","slug"),
	CONSTRAINT "locations_name_length" CHECK (char_length("app"."locations"."name") BETWEEN 1 AND 120),
	CONSTRAINT "locations_slug_format" CHECK ("app"."locations"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "locations_timezone_valid" CHECK (app_private.is_valid_iana_timezone("app"."locations"."timezone")),
	CONSTRAINT "locations_phone_e164" CHECK ("app"."locations"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "locations_slot_interval_valid" CHECK ("app"."locations"."slot_interval_min" IN (5, 10, 15, 20, 30, 60)),
	CONSTRAINT "locations_min_notice_range" CHECK ("app"."locations"."min_notice_min" BETWEEN 0 AND 43200),
	CONSTRAINT "locations_max_advance_range" CHECK ("app"."locations"."max_advance_days" BETWEEN 1 AND 365)
);
--> statement-breakpoint
CREATE TABLE "app"."services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"name" text NOT NULL,
	"duration_min" smallint NOT NULL,
	"phases" jsonb NOT NULL,
	"buffer_before_min" smallint DEFAULT 0 NOT NULL,
	"buffer_after_min" smallint DEFAULT 0 NOT NULL,
	"price_cents" integer NOT NULL,
	"commission_bps" integer,
	"online_bookable" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "services_name_length" CHECK (char_length("app"."services"."name") BETWEEN 1 AND 120),
	CONSTRAINT "services_duration_range" CHECK ("app"."services"."duration_min" BETWEEN 5 AND 720),
	CONSTRAINT "services_phases_valid" CHECK (app_private.service_phases_are_valid("app"."services"."phases", "app"."services"."duration_min")),
	CONSTRAINT "services_buffer_before_range" CHECK ("app"."services"."buffer_before_min" BETWEEN 0 AND 240),
	CONSTRAINT "services_buffer_after_range" CHECK ("app"."services"."buffer_after_min" BETWEEN 0 AND 240),
	CONSTRAINT "services_price_range" CHECK ("app"."services"."price_cents" BETWEEN 0 AND 100000000),
	CONSTRAINT "services_commission_range" CHECK ("app"."services"."commission_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "app"."staff_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"price_cents" integer,
	"duration_min" smallint,
	"commission_bps" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_services_tenant_staff_service_key" UNIQUE("tenant_id","staff_id","service_id"),
	CONSTRAINT "staff_services_price_range" CHECK ("app"."staff_services"."price_cents" BETWEEN 0 AND 100000000),
	CONSTRAINT "staff_services_duration_range" CHECK ("app"."staff_services"."duration_min" BETWEEN 5 AND 720),
	CONSTRAINT "staff_services_commission_range" CHECK ("app"."staff_services"."commission_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "app"."staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"display_name" text NOT NULL,
	"engagement_type" text NOT NULL,
	"phone_e164" text,
	"default_commission_bps" integer,
	"bookable_online" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_display_name_length" CHECK (char_length("app"."staff"."display_name") BETWEEN 1 AND 80),
	CONSTRAINT "staff_engagement_type_valid" CHECK ("app"."staff"."engagement_type" IN ('owner', 'employee', 'partner', 'freelancer')),
	CONSTRAINT "staff_phone_e164" CHECK ("app"."staff"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "staff_default_commission_range" CHECK ("app"."staff"."default_commission_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "app"."tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'trial' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_key" UNIQUE("slug"),
	CONSTRAINT "tenants_slug_format" CHECK ("app"."tenants"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "tenants_name_length" CHECK (char_length("app"."tenants"."name") BETWEEN 1 AND 120),
	CONSTRAINT "tenants_status_valid" CHECK ("app"."tenants"."status" IN ('trial', 'active', 'suspended', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "app"."appointment_events" ADD CONSTRAINT "appointment_events_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "app"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."appointment_items" ADD CONSTRAINT "appointment_items_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "app"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."appointment_items" ADD CONSTRAINT "appointment_items_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "app"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."appointment_items" ADD CONSTRAINT "appointment_items_staff_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "app"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."appointments" ADD CONSTRAINT "appointments_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "app"."locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."appointments" ADD CONSTRAINT "appointments_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "app"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."appointments" ADD CONSTRAINT "appointments_rescheduled_from_fk" FOREIGN KEY ("tenant_id","rescheduled_from_id") REFERENCES "app"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."occupancies" ADD CONSTRAINT "occupancies_appointment_item_fk" FOREIGN KEY ("tenant_id","appointment_id","appointment_item_id","staff_id") REFERENCES "app"."appointment_items"("tenant_id","appointment_id","id","staff_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."occupancies" ADD CONSTRAINT "occupancies_staff_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "app"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."time_off" ADD CONSTRAINT "time_off_staff_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "app"."staff"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."working_hours" ADD CONSTRAINT "working_hours_staff_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "app"."staff"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."working_hours" ADD CONSTRAINT "working_hours_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "app"."locations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customers" ADD CONSTRAINT "customers_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."locations" ADD CONSTRAINT "locations_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."services" ADD CONSTRAINT "services_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."staff_services" ADD CONSTRAINT "staff_services_staff_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "app"."staff"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."staff_services" ADD CONSTRAINT "staff_services_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "app"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."staff" ADD CONSTRAINT "staff_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_events_tenant_appointment_idx" ON "app"."appointment_events" USING btree ("tenant_id","appointment_id","created_at");--> statement-breakpoint
CREATE INDEX "appointment_items_tenant_staff_starts_idx" ON "app"."appointment_items" USING btree ("tenant_id","staff_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_items_tenant_service_idx" ON "app"."appointment_items" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "appointments_tenant_location_starts_idx" ON "app"."appointments" USING btree ("tenant_id","location_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_tenant_customer_starts_idx" ON "app"."appointments" USING btree ("tenant_id","customer_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_tenant_pending_hold_idx" ON "app"."appointments" USING btree ("tenant_id","hold_expires_at") WHERE "app"."appointments"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "occupancies_tenant_appointment_item_idx" ON "app"."occupancies" USING btree ("tenant_id","appointment_id","appointment_item_id");--> statement-breakpoint
CREATE INDEX "time_off_tenant_staff_during_idx" ON "app"."time_off" USING gist ("tenant_id","staff_id","during");--> statement-breakpoint
CREATE INDEX "working_hours_tenant_location_idx" ON "app"."working_hours" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_phone_key" ON "app"."customers" USING btree ("tenant_id","phone_e164") WHERE "app"."customers"."phone_e164" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customers_tenant_name_idx" ON "app"."customers" USING btree ("tenant_id",lower("full_name"));--> statement-breakpoint
CREATE INDEX "staff_services_tenant_service_idx" ON "app"."staff_services" USING btree ("tenant_id","service_id");