-- Distpatch virtual-model attribution (#9): the concrete model a virtual request (`auto-task`)
-- resolved to. Nullable and never back-filled: NULL is the honest value for a fixed request, where
-- no semantic selection happened, and for every row written before this column existed.
ALTER TABLE "usage_records" ADD COLUMN "selected_model" text;