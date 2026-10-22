CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_user_id_id_key" UNIQUE("user_id","id"),
	CONSTRAINT "projects_name_not_blank" CHECK (length(btrim("name")) > 0),
	CONSTRAINT "projects_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"priority" smallint DEFAULT 4 NOT NULL,
	"deadline" date,
	"estimate_min" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"series_id" uuid,
	"occurrence_date" date,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_user_id_id_key" UNIQUE("user_id","id"),
	CONSTRAINT "tasks_series_occurrence_key" UNIQUE("user_id","series_id","occurrence_date"),
	CONSTRAINT "tasks_title_not_blank" CHECK (length(btrim("title")) > 0),
	CONSTRAINT "tasks_priority_range" CHECK ("priority" between 1 and 4),
	CONSTRAINT "tasks_estimate_positive" CHECK ("estimate_min" > 0),
	CONSTRAINT "tasks_status_valid" CHECK ("status" in ('open', 'done', 'skipped')),
	CONSTRAINT "tasks_completed_at_matches_status" CHECK (("status" = 'open') = ("completed_at" is null)),
	CONSTRAINT "tasks_series_has_occurrence" CHECK (("series_id" is null) = ("occurrence_date" is null)),
	CONSTRAINT "tasks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade,
	-- Composite FK: a task can only reference a project owned by the same user.
	-- NO ACTION (not RESTRICT) so a user delete can cascade through both tables.
	CONSTRAINT "tasks_user_project_fk" FOREIGN KEY ("user_id","project_id") REFERENCES "projects"("user_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_one_open_per_series" ON "tasks" ("user_id","series_id") WHERE "status" = 'open';
--> statement-breakpoint
CREATE INDEX "tasks_user_project_idx" ON "tasks" ("user_id","project_id");
--> statement-breakpoint
CREATE TABLE "subtasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"title" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subtasks_title_not_blank" CHECK (length(btrim("title")) > 0),
	CONSTRAINT "subtasks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade,
	-- Composite FK: a subtask can only belong to a task owned by the same user.
	CONSTRAINT "subtasks_user_task_fk" FOREIGN KEY ("user_id","task_id") REFERENCES "tasks"("user_id","id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "subtasks_user_task_idx" ON "subtasks" ("user_id","task_id");
