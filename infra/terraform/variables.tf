variable "account_id" {
  type    = string
  default = "314e7e015b5f4429c4e2da1e6ec93271"
}

variable "email_allowlist" {
  type    = list(string)
  default = ["jack@jsmunro.me"]
}

variable "default_idp_type" {
  type    = string
  default = "github"
}

variable "workers_dev_subdomain" {
  type    = string
  default = ""
}
