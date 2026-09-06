CREATE TABLE `audit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`action` varchar(120) NOT NULL,
	`userId` int,
	`userCommand` text,
	`oldValue` text,
	`newValue` text,
	`reason` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `daily_performance` (
	`id` int AUTO_INCREMENT NOT NULL,
	`businessDate` timestamp NOT NULL,
	`testerId` int NOT NULL,
	`teamLeaderId` int NOT NULL,
	`projectId` int NOT NULL,
	`quantity` decimal(12,2) NOT NULL,
	`source` varchar(255),
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `daily_performance_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `imports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`fileName` varchar(255) NOT NULL,
	`sourceKey` varchar(500),
	`sourceUrl` varchar(500),
	`recordCount` int NOT NULL DEFAULT 0,
	`matchedCount` int NOT NULL DEFAULT 0,
	`exceptionCount` int NOT NULL DEFAULT 0,
	`status` enum('PROCESSED','PARTIAL','FAILED') NOT NULL DEFAULT 'PROCESSED',
	`rawData` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `imports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `payouts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`payoutDate` timestamp NOT NULL,
	`testerId` int,
	`teamLeaderId` int,
	`projectId` int,
	`testerNameRaw` varchar(160) NOT NULL,
	`projectNameRaw` varchar(160),
	`grossPayout` decimal(12,2) NOT NULL,
	`deductions` decimal(12,2) NOT NULL DEFAULT '0',
	`netPayout` decimal(12,2) NOT NULL,
	`transactionId` varchar(160),
	`sourceFile` varchar(255),
	`status` enum('MATCHED','UNMATCHED','POSSIBLE_MATCH','DUPLICATE','MISSING_AMOUNT','CONFLICT') NOT NULL DEFAULT 'MATCHED',
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payouts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(160) NOT NULL,
	`status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
	`notes` text,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `projects_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `targets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`testerId` int,
	`teamLeaderId` int,
	`projectId` int,
	`target` decimal(12,2) NOT NULL,
	`effectiveDate` timestamp NOT NULL,
	`endDate` timestamp,
	`level` enum('TESTER','TEAM_LEADER','PROJECT','DAILY','WEEKLY','MONTHLY') NOT NULL DEFAULT 'TESTER',
	`status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
	`notes` text,
	CONSTRAINT `targets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `team_leaders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(160) NOT NULL,
	`status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
	`dateAdded` timestamp NOT NULL DEFAULT (now()),
	`dateInactive` timestamp,
	`notes` text,
	CONSTRAINT `team_leaders_id` PRIMARY KEY(`id`),
	CONSTRAINT `team_leaders_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `testers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(160) NOT NULL,
	`teamLeaderId` int NOT NULL,
	`status` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
	`dateAdded` timestamp NOT NULL DEFAULT (now()),
	`dateInactive` timestamp,
	`notes` text,
	CONSTRAINT `testers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `performance_date_idx` ON `daily_performance` (`businessDate`);--> statement-breakpoint
CREATE INDEX `performance_tester_idx` ON `daily_performance` (`testerId`);--> statement-breakpoint
CREATE INDEX `payout_date_idx` ON `payouts` (`payoutDate`);--> statement-breakpoint
CREATE INDEX `payout_status_idx` ON `payouts` (`status`);--> statement-breakpoint
CREATE INDEX `testers_team_leader_idx` ON `testers` (`teamLeaderId`);