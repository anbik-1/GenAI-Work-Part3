# Performance Test Instructions — AnyCompanyRead

## Scope

This is a demo application with NFR-4 (Performance — Demo-Grade) requirements:
- API response time: < 1 second
- No aggressive optimization required

Performance testing is **optional** and lightweight for this project.

## Basic Performance Validation

### Manual Timing Check

After deployment, verify API response times are acceptable:

```bash
export API_URL="https://<api-gateway-id>.execute-api.<region>.amazonaws.com/prod"

# Time the books list endpoint (cold start + response)
time curl -s "$API_URL/books" > /dev/null
# Expected: < 3s for cold start, < 1s warm

# Time the book detail endpoint
time curl -s "$API_URL/books/<bookId>" > /dev/null
# Expected: < 1s

# Time authentication
time curl -s -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"testuser@example.com","password":"TestPass123"}' > /dev/null
# Expected: < 2s
```

### Lambda Cold Start Considerations

- **First invocation** after deployment: 2-5 seconds (Lambda cold start)
- **Subsequent invocations** (warm): < 500ms
- **After inactivity** (15+ minutes): Cold start again

This is acceptable for a demo application.

## Optional: Load Testing with Artillery

If you want to verify basic concurrency:

### 1. Install Artillery

```bash
npm install -g artillery
```

### 2. Create Test Script

Create `tests/performance/load-test.yml`:
```yaml
config:
  target: "https://<api-gateway-id>.execute-api.<region>.amazonaws.com/prod"
  phases:
    - duration: 30
      arrivalRate: 5
      name: "Low load"
    - duration: 30
      arrivalRate: 10
      name: "Medium load"

scenarios:
  - name: "Browse books"
    flow:
      - get:
          url: "/books"
      - get:
          url: "/books?genre=Fiction"
```

### 3. Run

```bash
artillery run tests/performance/load-test.yml
```

### 4. Expected Results

For demo-grade performance:
- **p95 response time**: < 2000ms
- **p99 response time**: < 5000ms (allowing for cold starts)
- **Error rate**: < 1%
- **DynamoDB throttling**: None (on-demand capacity handles burst)

## Cost Monitoring

Since DynamoDB is on-demand and Lambda is pay-per-invocation:
- Monitor AWS Cost Explorer after testing
- Expected cost: Near $0 for demo-level traffic
- Set up billing alerts if desired
