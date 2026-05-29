-- 0022_indexes.sql
-- Sprint 1 — Performance indexes (Section 11 of CHS-Database-Schema.md).
-- CREATE INDEX IF NOT EXISTS for idempotency.

-- Jobs
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_client_id ON jobs(client_id);
CREATE INDEX IF NOT EXISTS idx_jobs_job_type ON jobs(job_type);
CREATE INDEX IF NOT EXISTS idx_jobs_start_date ON jobs(start_date);

-- Tasks
CREATE INDEX IF NOT EXISTS idx_tasks_job_id ON tasks(job_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_date ON tasks(scheduled_date);

-- Estimates
CREATE INDEX IF NOT EXISTS idx_estimate_requests_status ON estimate_requests(status);
CREATE INDEX IF NOT EXISTS idx_estimate_requests_client_id ON estimate_requests(client_id);
CREATE INDEX IF NOT EXISTS idx_estimates_request_id ON estimates(request_id);
CREATE INDEX IF NOT EXISTS idx_estimates_status ON estimates(status);
CREATE INDEX IF NOT EXISTS idx_estimate_line_items_estimate_id ON estimate_line_items(estimate_id);
CREATE INDEX IF NOT EXISTS idx_estimate_sub_items_parent_id ON estimate_sub_items(parent_line_item_id);

-- Financial
CREATE INDEX IF NOT EXISTS idx_invoices_job_id ON invoices(job_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_job_id ON payments(job_id);
CREATE INDEX IF NOT EXISTS idx_expenses_job_id ON expenses(job_id);
CREATE INDEX IF NOT EXISTS idx_expenses_incurred_date ON expenses(incurred_date);
CREATE INDEX IF NOT EXISTS idx_time_entries_job_id ON time_entries(job_id);
CREATE INDEX IF NOT EXISTS idx_billing_cycles_job_id ON billing_cycles(job_id);

-- Photos
CREATE INDEX IF NOT EXISTS idx_photos_job_id ON photos(job_id);
CREATE INDEX IF NOT EXISTS idx_photos_photo_type ON photos(photo_type);
CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_is_social_ready ON photos(is_social_ready) WHERE is_social_ready = 1;

-- Documents
CREATE INDEX IF NOT EXISTS idx_documents_job_id ON documents(job_id);
CREATE INDEX IF NOT EXISTS idx_documents_context_type ON documents(context_type);
CREATE INDEX IF NOT EXISTS idx_documents_document_category ON documents(document_category);

-- Clients
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
CREATE INDEX IF NOT EXISTS idx_clients_high_level_contact_id ON clients(high_level_contact_id);

-- Communications
CREATE INDEX IF NOT EXISTS idx_communications_client_id ON communications(client_id);
CREATE INDEX IF NOT EXISTS idx_communications_job_id ON communications(job_id);
CREATE INDEX IF NOT EXISTS idx_communications_created_at ON communications(created_at);

-- Notifications
CREATE INDEX IF NOT EXISTS idx_notification_logs_job_id ON notification_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_status ON notification_logs(status);
CREATE INDEX IF NOT EXISTS idx_notification_logs_trigger_event ON notification_logs(trigger_event);

-- Social
CREATE INDEX IF NOT EXISTS idx_social_posts_status ON social_posts(status);
CREATE INDEX IF NOT EXISTS idx_social_posts_scheduled_date ON social_posts(scheduled_date);

-- Schedule
CREATE INDEX IF NOT EXISTS idx_schedule_entries_job_id ON schedule_entries(job_id);
CREATE INDEX IF NOT EXISTS idx_schedule_entries_scheduled_date ON schedule_entries(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_schedule_entries_sub_id ON schedule_entries(sub_id);

-- Audit
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_type ON audit_logs(entity_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_id ON audit_logs(entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- Smart Notes
CREATE INDEX IF NOT EXISTS idx_smart_notes_job_id ON smart_notes(job_id);

-- DLQ
CREATE INDEX IF NOT EXISTS idx_dlq_status ON dead_letter_queue(status);

-- Misc
CREATE INDEX IF NOT EXISTS idx_change_orders_job_id ON change_orders(job_id);
CREATE INDEX IF NOT EXISTS idx_permits_job_id ON permits(job_id);
CREATE INDEX IF NOT EXISTS idx_warranties_job_id ON warranties(job_id);
CREATE INDEX IF NOT EXISTS idx_daily_logs_job_id ON daily_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_daily_logs_log_date ON daily_logs(log_date);
CREATE INDEX IF NOT EXISTS idx_lien_waivers_job_id ON lien_waivers(job_id);
CREATE INDEX IF NOT EXISTS idx_mileage_job_id ON mileage(job_id);
CREATE INDEX IF NOT EXISTS idx_properties_client_id ON properties(client_id);
CREATE INDEX IF NOT EXISTS idx_vendor_materials_category ON vendor_materials(category);
