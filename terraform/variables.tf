variable "account_id" {
  description = "Cloudflare account id"
  type        = string
}

variable "allowed_emails" {
  description = "Identities allowed to authenticate to the ragbot admin Access application"
  type        = list(string)
}

variable "refresh_token_lifetime" {
  description = "How long a refresh token stays valid; bounds how long the CLI can run without a browser login"
  type        = string
  default     = "30d"
}
