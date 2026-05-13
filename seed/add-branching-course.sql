INSERT INTO acc_training_courses (course_code, course_name, description, version, duration_minutes, passing_score, required_for_roles, regulatory_reference, validity_period_days)
VALUES ('BRANCHING', 'Branching Logic and Conditional Fields', 'Learn to configure branching logic for conditional field display, required fields, and form linking. Based on SOP-019 Part B.', '8.0', 30, 80, '["admin","manager"]'::jsonb, '21 CFR Part 11', 365)
ON CONFLICT (course_code) DO NOTHING;
