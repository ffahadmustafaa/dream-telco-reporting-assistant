-- Track which user uploaded each dataset import so askDataset can enforce ownership.
ALTER TABLE `imports` ADD COLUMN `uploadedBy` int NULL;
CREATE INDEX `imports_uploaded_by_idx` ON `imports` (`uploadedBy`);
