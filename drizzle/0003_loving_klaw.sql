CREATE TABLE `otp_verifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`identifier` varchar(150) NOT NULL,
	`otpCode` varchar(6) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`isUsed` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `otp_verifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `accountRole` enum('admin','team_leader','tester') DEFAULT 'tester' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `phoneNumber` varchar(20);--> statement-breakpoint
ALTER TABLE `users` ADD `teamLeaderId` int;--> statement-breakpoint
ALTER TABLE `users` ADD `isVerified` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `accountStatus` enum('active','pending','blocked') DEFAULT 'pending' NOT NULL;