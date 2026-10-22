# Security Review Checklist

Use this checklist as a supplement to the main Code Review Skill. Apply only the checks relevant to the repository.

## Application Security

- [ ] Authentication enforced on protected endpoints.
- [ ] Authorization checked server-side for every sensitive operation.
- [ ] Object ownership and tenant isolation verified.
- [ ] SQL, NoSQL, command, template, and code injection assessed.
- [ ] XSS, CSRF, SSRF, path traversal, and unsafe redirects assessed where applicable.
- [ ] File uploads validated and safely stored.
- [ ] Secrets excluded from source code, logs, and API responses.
- [ ] Passwords and tokens handled securely.
- [ ] Session and JWT validation reviewed.
- [ ] Rate limiting and abuse controls assessed.
- [ ] Sensitive data exposure and caching assessed.
- [ ] Webhook authenticity and replay protections reviewed.
- [ ] Security headers and CORS policies reviewed.

## Data and Database Security

- [ ] Queries use safe parameterization.
- [ ] Tenant and ownership filters cannot be bypassed.
- [ ] Transactions protect critical multi-step operations.
- [ ] Concurrency and duplicate requests cannot corrupt critical state.
- [ ] Database permissions follow least privilege.
- [ ] Migrations preserve required data and constraints.
- [ ] Sensitive information is not logged unnecessarily.
- [ ] Backups and recovery requirements are considered where relevant.

## Dependencies and Infrastructure

- [ ] Dependency manifests and lockfiles reviewed.
- [ ] Known vulnerabilities checked with available tools.
- [ ] Exposed credentials and private keys checked.
- [ ] Docker images and container permissions reviewed.
- [ ] Containers avoid unnecessary root privileges.
- [ ] Secrets are not baked into container images.
- [ ] CI/CD permissions and secret exposure assessed.
- [ ] Environment configuration does not disable security protections.
- [ ] Debug interfaces and development endpoints are not exposed unintentionally.

## Test Coverage and Verification

- [ ] Critical business logic has meaningful assertions.
- [ ] Unauthorized access is tested.
- [ ] Invalid and malformed inputs are tested.
- [ ] Boundary conditions and failure paths are tested.
- [ ] Cross-tenant access attempts are tested where relevant.
- [ ] Regression tests exist for confirmed defects.
- [ ] Relevant automated tests have actually been executed.
- [ ] Failed, skipped, and blocked checks are reported accurately.

## Reporting

- [ ] Each finding has evidence and a precise location.
- [ ] Severity matches realistic impact and exploitability.
- [ ] Existing mitigations were checked.
- [ ] Findings are not duplicated.
- [ ] No secret values or sensitive customer data are disclosed.
- [ ] Unverified concerns are clearly labeled.
- [ ] Release recommendation follows the documented criteria.