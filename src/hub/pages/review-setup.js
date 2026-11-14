// The Grapim Review workflow file, one per model account. The setup
// checklist (team.js) hands these over; /docs/review and
// action/review/README.md show the same files (test/site.test.js keeps the
// three in step).

const HEAD = `name: Grapim Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
`;

const CHECKOUT = `jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
`;

const PERMS = `
permissions:
  contents: read
  pull-requests: write
`;

const PERMS_OIDC = `${PERMS}  id-token: write
`;

export const WORKFLOW_PATH = '.github/workflows/grapim-review.yml';

// { key, label, yaml }: the whole workflow file for that account.
export const REVIEW_PROVIDERS = [
  {
    key: 'anthropic',
    label: 'Anthropic API',
    yaml: `${HEAD}${PERMS}
${CHECKOUT}      - uses: grapim/grapim/action/review@main
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`,
  },
  {
    key: 'bedrock',
    label: 'Amazon Bedrock',
    yaml: `${HEAD}${PERMS_OIDC}
${CHECKOUT}      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/grapim-review
          aws-region: us-east-1
      - uses: grapim/grapim/action/review@main
        with:
          provider: bedrock
`,
  },
  {
    key: 'vertex',
    label: 'Google Vertex AI',
    yaml: `${HEAD}${PERMS_OIDC}
${CHECKOUT}      - id: gcp
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: projects/123456789/locations/global/workloadIdentityPools/github/providers/github
          service_account: grapim-review@my-project.iam.gserviceaccount.com
          token_format: access_token
      - uses: grapim/grapim/action/review@main
        with:
          provider: vertex
        env:
          GOOGLE_CLOUD_PROJECT: my-project
          GOOGLE_CLOUD_REGION: global
          GOOGLE_OAUTH_ACCESS_TOKEN: \${{ steps.gcp.outputs.access_token }}
`,
  },
  {
    key: 'foundry',
    label: 'Microsoft Foundry',
    yaml: `${HEAD}${PERMS}
${CHECKOUT}      - uses: grapim/grapim/action/review@main
        with:
          provider: foundry
        env:
          ANTHROPIC_FOUNDRY_API_KEY: \${{ secrets.ANTHROPIC_FOUNDRY_API_KEY }}
          ANTHROPIC_FOUNDRY_RESOURCE: my-foundry-resource
`,
  },
];
