-- Normalize the legacy "Inception" project to "Section X" without losing history.
-- Canonical projects after this migration: exactly "Section X" and "Super X".
-- `projects.name` is UNIQUE, so every branch below is written to be idempotent
-- and to never violate that constraint.

-- Resolve the two candidate ids (NULL when the row does not exist).
SET @inception_id = (SELECT `id` FROM `projects` WHERE `name` = 'Inception' LIMIT 1);
SET @sectionx_id = (SELECT `id` FROM `projects` WHERE `name` = 'Section X' LIMIT 1);

-- Case A: only "Inception" exists -> rename it in place. The id is preserved,
-- so every linked row (daily_performance, targets, payouts, payout_rules) keeps working.
UPDATE `projects` SET `name` = 'Section X' WHERE `name` = 'Inception' AND @sectionx_id IS NULL;

-- Refresh ids after the rename above.
SET @inception_id = (SELECT `id` FROM `projects` WHERE `name` = 'Inception' LIMIT 1);
SET @sectionx_id = (SELECT `id` FROM `projects` WHERE `name` = 'Section X' LIMIT 1);

-- Case C: both rows exist -> fold "Inception" history into the canonical "Section X" row.
-- First merge daily rows that would otherwise double-report the same tester/date/leader
-- by summing their quantities into the Section X row.
UPDATE `daily_performance` AS target
JOIN `daily_performance` AS src
  ON src.`projectId` = @inception_id
 AND target.`projectId` = @sectionx_id
 AND target.`testerId` = src.`testerId`
 AND target.`businessDate` = src.`businessDate`
 AND target.`teamLeaderId` = src.`teamLeaderId`
SET target.`quantity` = target.`quantity` + src.`quantity`
WHERE @inception_id IS NOT NULL AND @sectionx_id IS NOT NULL AND @inception_id <> @sectionx_id;

DELETE src FROM `daily_performance` AS src
JOIN `daily_performance` AS target
  ON src.`projectId` = @inception_id
 AND target.`projectId` = @sectionx_id
 AND target.`testerId` = src.`testerId`
 AND target.`businessDate` = src.`businessDate`
 AND target.`teamLeaderId` = src.`teamLeaderId`
WHERE @inception_id IS NOT NULL AND @sectionx_id IS NOT NULL AND @inception_id <> @sectionx_id;

-- Re-point the remaining references to the canonical Section X row.
UPDATE `daily_performance` SET `projectId` = @sectionx_id WHERE `projectId` = @inception_id AND @inception_id IS NOT NULL AND @sectionx_id IS NOT NULL AND @inception_id <> @sectionx_id;
UPDATE `targets` SET `projectId` = @sectionx_id WHERE `projectId` = @inception_id AND @inception_id IS NOT NULL AND @sectionx_id IS NOT NULL AND @inception_id <> @sectionx_id;
UPDATE `payouts` SET `projectId` = @sectionx_id WHERE `projectId` = @inception_id AND @inception_id IS NOT NULL AND @sectionx_id IS NOT NULL AND @inception_id <> @sectionx_id;
UPDATE `payout_rules` SET `projectId` = @sectionx_id WHERE `projectId` = @inception_id AND @inception_id IS NOT NULL AND @sectionx_id IS NOT NULL AND @inception_id <> @sectionx_id;

-- Drop the now-unreferenced duplicate "Inception" row (only when Section X exists).
DELETE FROM `projects` WHERE `name` = 'Inception' AND @sectionx_id IS NOT NULL;

-- Case B / fresh databases: make sure both canonical projects exist.
INSERT INTO `projects` (`name`, `status`) SELECT 'Section X', 'ACTIVE' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `projects` WHERE `name` = 'Section X');
INSERT INTO `projects` (`name`, `status`) SELECT 'Super X', 'ACTIVE' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `projects` WHERE `name` = 'Super X');
