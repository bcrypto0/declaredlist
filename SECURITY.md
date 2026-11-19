# Security policy

## Reporting a vulnerability

Report a vulnerability in this site, its scanner or its build through GitHub private vulnerability reporting: open the Security tab of this repository and choose "Report a vulnerability". Only you and the maintainers of this repository can read the report.

If that button is not shown, private reporting is turned off for this repository. Then open an issue at https://github.com/bcrypto0/declaredlist/issues that asks for a private way to send a report, without any detail of the problem.

Please do not open a public issue, pull request or discussion about a vulnerability until it has been fixed.

A useful report names the commit you tested, the command and the input (for example a registry listing or a data file) that shows the problem, and what you expected instead.

## What is in scope

* The scanner (`scan/`), the static generator (`build/`) and the shared helpers (`lib/`), for example registry or publisher text that reaches a page unescaped, a link to a scheme other than https, a file written outside its folder, or a scan that publishes data it should have rejected.
* The pages and the headers file the build writes into `dist/`.
* The GitHub Actions workflows in `.github/workflows/`.

## What is not in scope

* The checker addon-declare and the Add on Declaration Spec: report to https://github.com/bcrypto0/addon-declaration (its own security policy applies).
* The MCP Registry, `mcp-publisher` and any server listed on the site: report to those projects or publishers.
* A check result you think is wrong but that does not come from a vulnerability: open an issue at https://github.com/bcrypto0/declaredlist/issues instead.

## Versions

Fixes are made on the default branch only. There is no fixed response time.
