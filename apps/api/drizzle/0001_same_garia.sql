CREATE TABLE "pending_password_resets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "used_recovery_sessions" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_password_resets" ADD CONSTRAINT "pending_password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_password_resets_effective_idx" ON "pending_password_resets" USING btree ("effective_at");--> statement-breakpoint
CREATE INDEX "used_recovery_sessions_expires_idx" ON "used_recovery_sessions" USING btree ("expires_at");