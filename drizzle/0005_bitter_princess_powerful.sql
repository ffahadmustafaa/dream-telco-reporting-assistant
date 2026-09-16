CREATE TABLE `auth_challenges` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`emailOtp` varchar(6) NOT NULL,
	`phoneOtp` varchar(6) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`isCompleted` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auth_challenges_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `emailVerified` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `phoneVerified` int DEFAULT 0 NOT NULL;