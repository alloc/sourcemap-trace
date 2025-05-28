import type { Options } from '@cspotcode/source-map-support'
import assert from 'node:assert'

export type RetrieveSourceMapFunction = NonNullable<
  Options['retrieveSourceMap']
>

const placeholderError = new Error()
export function getSourceMappedString(
  value: string,
  retrieveSourceMap?: RetrieveSourceMapFunction
): string {
  // We could use `.replace()` here with a function replacer, but
  // `getSourceMappingPrepareStackTrace()` clears its source map caches between
  // operations. It's likely call sites in this `value` will share source maps,
  // so instead we find all call sites, source map them together, then replace.
  // Note this still works if there are multiple instances of the same call site
  // (e.g. stack overflow error), as the final `.replace()`s will only replace
  // the first instance. If they replace the value with itself, all instances
  // of the call site would've been replaced with the same thing.
  const callSiteLines = Array.from(value.matchAll(CALL_SITE_REGEXP))
  const callSites = callSiteLines.map(lineMatchToCallSite)
  const prepareStack = getSourceMappingPrepareStackTrace(retrieveSourceMap)
  const sourceMappedStackTrace: string = prepareStack(
    placeholderError,
    callSites
  )
  const sourceMappedCallSiteLines = sourceMappedStackTrace.split('\n').slice(1)

  for (let i = 0; i < callSiteLines.length; i++) {
    // If a call site doesn't have a file name, it's likely invalid, so don't
    // apply source mapping (see cloudflare/workers-sdk#4668)
    if (callSites[i].getFileName() === undefined) {
      continue
    }

    const callSiteLine = callSiteLines[i][0]
    const callSiteAtIndex = callSiteLine.indexOf('at')
    assert(callSiteAtIndex !== -1) // Matched against `CALL_SITE_REGEXP`
    const callSiteLineLeftPad = callSiteLine.substring(0, callSiteAtIndex)
    value = value.replace(
      callSiteLine,
      callSiteLineLeftPad + sourceMappedCallSiteLines[i].trimStart()
    )
  }
  return value
}

// `sourceMappingPrepareStackTrace` is initialised on the first call to
// `getSourceMappingPrepareStackTrace()`. Subsequent calls to
// `getSourceMappingPrepareStackTrace()` will not update it. We'd like to be
// able to customise source map retrieval on each call though. Therefore, we
// make `retrieveSourceMapOverride` a module level variable, so
// `sourceMappingPrepareStackTrace` always has access to the latest override.
let sourceMappingPrepareStackTrace: typeof Error.prepareStackTrace
let retrieveSourceMapOverride: RetrieveSourceMapFunction | undefined

function getSourceMappingPrepareStackTrace(
  retrieveSourceMap?: RetrieveSourceMapFunction
): NonNullable<typeof Error.prepareStackTrace> {
  // Source mapping is synchronous, so setting a module level variable is fine
  retrieveSourceMapOverride = retrieveSourceMap
  // If we already have a source mapper, return it
  if (sourceMappingPrepareStackTrace !== undefined) {
    return sourceMappingPrepareStackTrace
  }

  const support: typeof import('@cspotcode/source-map-support') =
    getFreshSourceMapSupport()

  const originalPrepareStackTrace = Error.prepareStackTrace
  support.install({
    environment: 'node',
    // Don't add Node `uncaughtException` handler
    handleUncaughtExceptions: false,
    // Don't hook Node `require` function
    hookRequire: false,
    redirectConflictingLibrary: false,
    // Make sure we're using fresh copies of files each time we source map
    emptyCacheBetweenOperations: true,
    // Allow retriever to be overridden at prepare stack trace time
    retrieveSourceMap(path) {
      return retrieveSourceMapOverride?.(path) ?? null
    },
  })
  sourceMappingPrepareStackTrace = Error.prepareStackTrace
  assert(sourceMappingPrepareStackTrace !== undefined)
  Error.prepareStackTrace = originalPrepareStackTrace

  return sourceMappingPrepareStackTrace
}

// `source-map-support` will only modify `Error.prepareStackTrace` if this is
// the first time `install()` has been called. This is governed by shared data
// stored using a well-known symbol on `globalThis`. To ensure...
//
// a) `miniflare` and `wrangler` can have differing `install()` options
// b) We're not affecting external user's use of this package
// c) `Error.prepareStackTrace` is always updated on `install()`
//
// ...load a fresh copy, by resetting then restoring the `require` cache, and
// overriding `Symbol.for()` to return a unique symbol.
export function getFreshSourceMapSupport(): typeof import('@cspotcode/source-map-support') {
  const resolvedSupportPath = require.resolve('@cspotcode/source-map-support')

  const originalSymbolFor = Symbol.for
  const originalSupport = require.cache[resolvedSupportPath]
  try {
    Symbol.for = key => {
      // Make sure we only override the expected symbol. If we upgrade this
      // package, and new symbols are used, this assertion will fail in tests.
      // We want to guard against `source-map-support/sharedData` changing to
      // something else. If this new symbol *should* be shared across package
      // instances, we'll need to add an
      // `if (key === "...") return originalSymbolFor(key);` here.
      assert.strictEqual(key, 'source-map-support/sharedData')
      return Symbol(key)
    }
    delete require.cache[resolvedSupportPath]
    return require(resolvedSupportPath)
  } finally {
    Symbol.for = originalSymbolFor
    require.cache[resolvedSupportPath] = originalSupport
  }
}

// Adapted from `node-stack-trace`:
/*!
 * Copyright (c) 2011 Felix Geisendörfer (felix@debuggable.com)
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy
 *  of this software and associated documentation files (the "Software"), to deal
 *  in the Software without restriction, including without limitation the rights
 *  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *  copies of the Software, and to permit persons to whom the Software is
 *  furnished to do so, subject to the following conditions:
 *
 *  The above copyright notice and this permission notice shall be included in
 *  all copies or substantial portions of the Software.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 *  THE SOFTWARE.
 */

const CALL_SITE_REGEXP =
  // Validation errors from `wrangler deploy` have a 2 space indent, whereas
  // regular stack traces have a 4 space indent.
  /^(?:\s+(?:\x1B\[\d+m)?'?)? {2,4}at (?:(.+?)\s+\()?(?:(.+?):(\d+)(?::(\d+))?|([^)]+))\)?/gm

function lineMatchToCallSite(lineMatch: RegExpMatchArray): CallSite {
  let object: string | null = null
  let method: string | null = null
  let functionName: string | null = null
  let typeName: string | null = null
  let methodName: string | null = null
  const isNative = lineMatch[5] === 'native'

  if (lineMatch[1]) {
    functionName = lineMatch[1]
    let methodStart = functionName.lastIndexOf('.')
    if (functionName[methodStart - 1] == '.') {
      methodStart--
    }
    if (methodStart > 0) {
      object = functionName.substring(0, methodStart)
      method = functionName.substring(methodStart + 1)
      const objectEnd = object.indexOf('.Module')
      if (objectEnd > 0) {
        functionName = functionName.substring(objectEnd + 1)
        object = object.substring(0, objectEnd)
      }
    }
  }

  if (method) {
    typeName = object
    methodName = method
  }

  if (method === '<anonymous>') {
    methodName = null
    functionName = null
  }

  return new CallSite({
    typeName,
    functionName,
    methodName,
    fileName: lineMatch[2],
    lineNumber: parseInt(lineMatch[3]) || null,
    columnNumber: parseInt(lineMatch[4]) || null,
    native: isNative,
  })
}

interface CallSiteOptions {
  typeName: string | null
  functionName: string | null
  methodName: string | null
  fileName: string
  lineNumber: number | null
  columnNumber: number | null
  native: boolean
}

// https://v8.dev/docs/stack-trace-api#customizing-stack-traces
// This class supports the subset of options implemented by `node-stack-trace`:
// https://github.com/felixge/node-stack-trace/blob/4c41a4526e74470179b3b6dd5d75191ca8c56c17/index.js
class CallSite implements NodeJS.CallSite {
  constructor(private readonly opts: CallSiteOptions) {}
  getScriptHash(): string {
    throw new Error('Method not implemented.')
  }
  getEnclosingColumnNumber(): number {
    throw new Error('Method not implemented.')
  }
  getEnclosingLineNumber(): number {
    throw new Error('Method not implemented.')
  }
  getPosition(): number {
    throw new Error('Method not implemented.')
  }
  getThis(): unknown {
    return null
  }
  getTypeName(): string | null {
    return this.opts.typeName
  }
  getFunction(): Function | undefined {
    return undefined
  }
  getFunctionName(): string | null {
    return this.opts.functionName
  }
  getMethodName(): string | null {
    return this.opts.methodName
  }
  getFileName(): string {
    return this.opts.fileName
  }
  getScriptNameOrSourceURL(): string {
    return this.opts.fileName
  }
  getLineNumber(): number | null {
    return this.opts.lineNumber
  }
  getColumnNumber(): number | null {
    return this.opts.columnNumber
  }
  getEvalOrigin(): string | undefined {
    return undefined
  }
  isToplevel(): boolean {
    return false
  }
  isEval(): boolean {
    return false
  }
  isNative(): boolean {
    return this.opts.native
  }
  isConstructor(): boolean {
    return false
  }
  isAsync(): boolean {
    return false
  }
  isPromiseAll(): boolean {
    return false
  }
  isPromiseAny(): boolean {
    return false
  }
  getPromiseIndex(): number | null {
    return null
  }
}
