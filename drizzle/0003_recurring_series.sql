CREATE TABLE "recurring_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"priority" smallint DEFAULT 4 NOT NULL,
	"estimate_min" integer,
	"kind" text NOT NULL,
	"interval" integer DEFAULT 1 NOT NULL,
	"weekdays" smallint[],
	"start_date" date NOT NULL,
	"end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_series_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "recurring_series_title_not_blank" CHECK (length(btrim("recurring_series"."title")) between 1 and 500),
	CONSTRAINT "recurring_series_priority_range" CHECK ("recurring_series"."priority" between 1 and 4),
	CONSTRAINT "recurring_series_estimate_min_range" CHECK ("recurring_series"."estimate_min" between 1 and 1440),
	CONSTRAINT "recurring_series_kind_valid" CHECK ("recurring_series"."kind" in ('daily', 'weekly')),
	CONSTRAINT "recurring_series_interval_range" CHECK ("recurring_series"."interval" between 1 and 365),
	CONSTRAINT "recurring_series_weekdays_match_kind" CHECK (case when "recurring_series"."kind" = 'weekly'
        then cardinality("recurring_series"."weekdays") between 1 and 7 and "recurring_series"."weekdays" <@ array[0,1,2,3,4,5,6]::smallint[]
        else "recurring_series"."weekdays" is null end),
	CONSTRAINT "recurring_series_end_after_start" CHECK ("recurring_series"."end_date" is null or "recurring_series"."end_date" >= "recurring_series"."start_date")
);
--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_user_project_fk" FOREIGN KEY ("user_id","project_id") REFERENCES "public"."projects"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_series_user_id_idx" ON "recurring_series" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "occurrence_date" date;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_series_fk" FOREIGN KEY ("user_id","series_id") REFERENCES "public"."recurring_series"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_series_occurrence_unique" UNIQUE("series_id","occurrence_date");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_series_has_occurrence_date" CHECK (("tasks"."series_id" is null) = ("tasks"."occurrence_date" is null));--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_one_open_per_series" ON "tasks" USING btree ("series_id") WHERE "tasks"."status" = 'open' and "tasks"."series_id" is not null;
