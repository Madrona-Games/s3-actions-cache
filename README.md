# actions-s3-cache

This action enables caching dependencies to S3-compatible storage, e.g. Amazon S3, Cloudflare R2

It also has github [actions/cache@v2](https://github.com/actions/cache) fallback if s3 save & restore fails

## Usage

```yaml
name: dev ci

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build_test:
    runs-on: [ubuntu-latest]

    steps:
      - uses: Madrona-Games/s3-actions-cache@v2
        with:
          endpoint: s3.example.com # optional, default s3.amazonaws.com
          insecure: false # optional, use http instead of https. default false
          accessKey: "mykey" # required
          secretKey: "secret" # required
          sessionToken: "token" # optional
          bucket: actions-cache # required
          use-fallback: true # optional, use github actions cache fallback, default true
          partSize: 256 # optional
          # actions/cache compatible properties: https://github.com/actions/cache
          key: ${{ runner.os }}-yarn-${{ hashFiles('**/yarn.lock') }}
          path: |
            node_modules
            .cache
          restore-keys: |
            ${{ runner.os }}-yarn-
```

You can also set env instead of using `with`:

```yaml
      - uses: Madrona-Games/s3-actions-cache@v2
        env:
          AWS_ACCESS_KEY_ID: "mykey"
          AWS_SECRET_ACCESS_KEY: "secret"
          # AWS_SESSION_TOKEN: "token"
          AWS_REGION: "us-east-1"
        with:
          endpoint: s3.example.com # optional, default s3.amazonaws.com
          bucket: actions-cache
          use-fallback: false
          key: test-${{ runner.os }}-${{ github.run_id }}
          path: |
            test-cache
            ~/test-cache
```

To write to the cache only:

```yaml
      - uses: Madrona-Games/s3-actions-cache/save@v2
        with:
          accessKey: "mykey" # required
          secretKey: "secret" # required
          bucket: actions-cache # required
          # actions/cache compatible properties: https://github.com/actions/cache
          key: ${{ runner.os }}-yarn-${{ hashFiles('**/yarn.lock') }}
          path: |
            node_modules
```

To restore from the cache only:

```yaml
      - uses: Madrona-Games/s3-actions-cache/restore@v2
        with:
          accessKey: "mykey" # required
          secretKey: "secret" # required
          bucket: actions-cache # required
          # actions/cache compatible properties: https://github.com/actions/cache
          key: ${{ runner.os }}-yarn-${{ hashFiles('**/yarn.lock') }}
          path: |
            node_modules
```

## Restore keys

`restore-keys` works similar to how github's `@actions/cache@v2` works: It search each item in `restore-keys`
as prefix in object names and use the latest one

## Amazon S3 permissions

When using this with Amazon S3, the following permissions are necessary:

 - `s3:PutObject`
 - `s3:GetObject`
 - `s3:ListBucket`
 - `s3:GetBucketLocation`
 - `s3:ListBucketMultipartUploads`
 - `s3:ListMultipartUploadParts`

# Note on release

This project follows semantic versioning. Backward incompatible changes will
increase major version.

There is also the `v2` compatible tag that's always pinned to the latest
`v2.x.y` release.

It's done using:

```
git tag -a v2 -f -m "v2 compatible release"
git push -f --tags
```
