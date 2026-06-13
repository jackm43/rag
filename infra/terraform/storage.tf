resource "cloudflare_d1_database" "ragbot" {
  account_id       = var.account_id
  read_replication = { mode = "disabled" }
  name             = "ragbot"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_d1_database" "rag_auth_gateway" {
  account_id       = var.account_id
  read_replication = { mode = "disabled" }
  name             = "rag-auth-gateway"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_d1_database" "discovery" {
  account_id       = var.account_id
  read_replication = { mode = "disabled" }
  name             = "discovery"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_queue" "ai_jobs" {
  account_id = var.account_id
  queue_name = "ai-jobs"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_queue" "ai_jobs_dlq" {
  account_id = var.account_id
  queue_name = "ai-jobs-dlq"

  lifecycle {
    prevent_destroy = true
  }
}
