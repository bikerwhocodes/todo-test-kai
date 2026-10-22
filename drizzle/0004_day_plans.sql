CREATE TABLE "day_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"plan_date" date NOT NULL,
	"available_min" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "day_plans_user_id_plan_date_unique" UNIQUE("user_id","plan_date"),
	CONSTRAINT "day_plans_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "day_plans_available_min_range" CHECK ("day_plans"."available_min" between 0 and 1440)
);
--> statement-breakpoint
CREATE TABLE "plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"day_plan_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_items_day_plan_id_task_id_unique" UNIQUE("day_plan_id","task_id"),
	CONSTRAINT "plan_items_position_nonnegative" CHECK ("plan_items"."position" >= 0),
	CONSTRAINT "plan_items_source_valid" CHECK ("plan_items"."source" in ('suggested', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "plan_dismissals" (
	"user_id" text NOT NULL,
	"plan_date" date NOT NULL,
	"task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_dismissals_user_id_plan_date_task_id_pk" PRIMARY KEY("user_id","plan_date","task_id")
);
--> statement-breakpoint
ALTER TABLE "day_plans" ADD CONSTRAINT "day_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_user_day_plan_fk" FOREIGN KEY ("user_id","day_plan_id") REFERENCES "public"."day_plans"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_user_task_fk" FOREIGN KEY ("user_id","task_id") REFERENCES "public"."tasks"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_dismissals" ADD CONSTRAINT "plan_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_dismissals" ADD CONSTRAINT "plan_dismissals_user_task_fk" FOREIGN KEY ("user_id","task_id") REFERENCES "public"."tasks"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_items_user_id_task_id_idx" ON "plan_items" USING btree ("user_id","task_id");--> statement-breakpoint
CREATE INDEX "plan_dismissals_user_id_task_id_idx" ON "plan_dismissals" USING btree ("user_id","task_id");
