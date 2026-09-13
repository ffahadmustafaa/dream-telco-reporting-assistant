CREATE TABLE `payout_rules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`testerId` int,
	`ratePerOtp` decimal(12,2),
	`fixedAmount` decimal(12,2),
	`status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payout_rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `payout_rules_project_idx` ON `payout_rules` (`projectId`);--> statement-breakpoint
CREATE INDEX `payout_rules_tester_idx` ON `payout_rules` (`testerId`);