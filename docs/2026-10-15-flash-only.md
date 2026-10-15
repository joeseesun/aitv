# Flash-only model policy

The scheduled script writer defaulted to deepseek-v4-pro, so background jobs could spend Pro tokens without an interactive model selection. Worker variables, local script defaults and the shared transport now use deepseek-flash. Runtime validation rejects Pro and legacy ambiguous model names before sending a request; the explicit old Flash alias is normalized to Flash.

The transport accepts only the official HTTPS endpoint, refuses redirects, disables thinking, limits the request to 100,000 UTF-8 bytes and output to 4096 tokens, and rejects truncated output. Logs contain model/token usage only. Existing 40-item daily pipeline and retry limits remain in place; these are not a provider-account spending cap.

Validation: all three new regression tests failed on the previous implementation; 187 tests now pass. Cloudflare dry-run builds successfully with both model bindings set to Flash. Deploy using npm run deploy and verify live commit, bindings and cron.
