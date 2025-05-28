# resolve-stack-sources

Rewrite a stack trace with source maps. This package was extracted from [wrangler](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/) to be used by other frameworks.

```
pnpm add resolve-stack-sources
```

## Usage

```ts
import { getSourceMappedString } from 'resolve-stack-sources'

const sourceMappedStackTrace = getSourceMappedString(error.stack)
// => string
```

You may pass a custom `retrieveSourceMap` function to the `getSourceMappedString` function.

```ts
import { getSourceMappedString } from 'resolve-stack-sources'

function retrieveSourceMap(source: string) {
  // The `source` is the path to the source file.
  // You must return either null or a { url, map } object.
}

const sourceMappedStackTrace = getSourceMappedString(
  error.stack,
  retrieveSourceMap
)
```
