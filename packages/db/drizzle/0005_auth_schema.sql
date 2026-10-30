CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE TABLE "auth"."accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_provider_account_key" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "auth"."members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_organization_user_key" UNIQUE("organization_id","user_id"),
	CONSTRAINT "members_role_valid" CHECK ("auth"."members"."role" IN ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "auth"."organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" text,
	CONSTRAINT "organizations_slug_key" UNIQUE("slug"),
	CONSTRAINT "organizations_name_length" CHECK (char_length("auth"."organizations"."name") BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE "auth"."rate_limits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limits_key_key" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "auth"."sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "sessions_token_key" UNIQUE("token"),
	CONSTRAINT "sessions_user_agent_length" CHECK (char_length("auth"."sessions"."user_agent") <= 1024),
	CONSTRAINT "sessions_ip_address_length" CHECK (char_length("auth"."sessions"."ip_address") <= 64)
);
--> statement-breakpoint
CREATE TABLE "auth"."users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email"),
	CONSTRAINT "users_name_length" CHECK (char_length("auth"."users"."name") BETWEEN 1 AND 120),
	CONSTRAINT "users_email_length" CHECK (char_length("auth"."users"."email") BETWEEN 3 AND 254),
	CONSTRAINT "users_email_lowercase" CHECK ("auth"."users"."email" = lower("auth"."users"."email")),
	CONSTRAINT "users_image_length" CHECK (char_length("auth"."users"."image") <= 2048)
);
--> statement-breakpoint
CREATE TABLE "auth"."verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."accounts" ADD CONSTRAINT "accounts_user_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."members" ADD CONSTRAINT "members_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."members" ADD CONSTRAINT "members_user_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."organizations" ADD CONSTRAINT "organizations_tenant_fk" FOREIGN KEY ("id") REFERENCES "app"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."sessions" ADD CONSTRAINT "sessions_user_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "auth"."accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "members_user_id_idx" ON "auth"."members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "auth"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "auth"."verifications" USING btree ("identifier");