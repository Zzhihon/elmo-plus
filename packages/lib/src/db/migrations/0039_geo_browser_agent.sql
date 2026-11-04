ALTER TABLE "geo_observations" DROP CONSTRAINT "geo_observations_platform_check";--> statement-breakpoint
ALTER TABLE "geo_observations" DROP CONSTRAINT "geo_observations_surface_mode_check";--> statement-breakpoint
ALTER TABLE "geo_sampling_targets" DROP CONSTRAINT "geo_sampling_targets_platform_check";--> statement-breakpoint
ALTER TABLE "geo_sampling_targets" DROP CONSTRAINT "geo_sampling_targets_surface_mode_check";--> statement-breakpoint
ALTER TABLE "geo_simulation_runs" DROP CONSTRAINT "geo_simulation_runs_platform_check";--> statement-breakpoint
ALTER TABLE "geo_simulation_runs" DROP CONSTRAINT "geo_simulation_runs_surface_mode_check";--> statement-breakpoint
ALTER TABLE "geo_observations" ADD CONSTRAINT "geo_observations_platform_check" CHECK ("geo_observations"."platform" in ('doubao', 'deepseek', 'yuanbao', 'qwen', 'chatgpt', 'gemini'));--> statement-breakpoint
ALTER TABLE "geo_observations" ADD CONSTRAINT "geo_observations_surface_mode_check" CHECK ("geo_observations"."surface_mode" in ('LIVE_SURFACE', 'BROWSER_AGENT', 'MODEL_API', 'MANUAL_EVIDENCE'));--> statement-breakpoint
ALTER TABLE "geo_sampling_targets" ADD CONSTRAINT "geo_sampling_targets_platform_check" CHECK ("geo_sampling_targets"."platform" in ('doubao', 'deepseek', 'yuanbao', 'qwen', 'chatgpt', 'gemini'));--> statement-breakpoint
ALTER TABLE "geo_sampling_targets" ADD CONSTRAINT "geo_sampling_targets_surface_mode_check" CHECK ("geo_sampling_targets"."surface_mode" in ('LIVE_SURFACE', 'BROWSER_AGENT', 'MODEL_API', 'MANUAL_EVIDENCE'));--> statement-breakpoint
ALTER TABLE "geo_simulation_runs" ADD CONSTRAINT "geo_simulation_runs_platform_check" CHECK ("geo_simulation_runs"."platform" in ('doubao', 'deepseek', 'yuanbao', 'qwen', 'chatgpt', 'gemini'));--> statement-breakpoint
ALTER TABLE "geo_simulation_runs" ADD CONSTRAINT "geo_simulation_runs_surface_mode_check" CHECK ("geo_simulation_runs"."surface_mode" in ('LIVE_SURFACE', 'BROWSER_AGENT', 'MODEL_API', 'MANUAL_EVIDENCE'));