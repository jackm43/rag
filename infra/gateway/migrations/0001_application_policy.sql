ALTER TABLE idp_applications ADD COLUMN provider TEXT NOT NULL DEFAULT '';
ALTER TABLE idp_applications ADD COLUMN trust_boundary TEXT NOT NULL DEFAULT '{}';
ALTER TABLE idp_applications ADD COLUMN access TEXT NOT NULL DEFAULT '{}';
