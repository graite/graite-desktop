"""Mail: accounts, a local read-only copy of each mailbox, and the service that keeps it fresh.

Accounts are app-wide (`~/.graite/mail.json`, passwords in the OS keychain). The copy of the
mail lives under the vault's `.graite/mail/<account id>/`: derivable state that is made again
from the mail server, never part of the vault's pages and never synced between devices.
Nothing here changes anything on the mail server: folders are opened read-only.
"""
