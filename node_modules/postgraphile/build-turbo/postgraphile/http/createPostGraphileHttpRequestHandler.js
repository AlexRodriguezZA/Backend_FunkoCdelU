"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEmpty = void 0;
/* eslint-disable @typescript-eslint/no-explicit-any,require-atomic-updates */
const graphql_1 = require("graphql");
const extendedFormatError_1 = require("../extendedFormatError");
const pluginHook_1 = require("../pluginHook");
const setupServerSentEvents_1 = require("./setupServerSentEvents");
const withPostGraphileContext_1 = require("../withPostGraphileContext");
const lru_1 = require("@graphile/lru");
const chalk_1 = require("chalk");
const Debugger = require("debug"); // tslint:disable-line variable-name
const httpError = require("http-errors");
const parseUrl = require("parseurl");
const finalHandler = require("finalhandler");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const isKoaApp = (a, b) => a.req && a.res && typeof b === 'function';
const CACHE_MULTIPLIER = 100000;
const ALLOW_EXPLAIN_PLACEHOLDER = '__SHOULD_ALLOW_EXPLAIN__';
const noop = () => {
    /* noop */
};
const { createHash } = crypto;
/**
 * The favicon file in `Buffer` format. We can send a `Buffer` directly to the
 * client.
 *
 * @type {Buffer}
 */
const favicon_ico_1 = require("../../assets/favicon.ico");
/**
 * The GraphiQL HTML file as a string. We need it to be a string, because we
 * will use a regular expression to replace some variables.
 */
const graphiql_html_1 = require("../../assets/graphiql.html");
const subscriptions_1 = require("./subscriptions");
const frameworks_1 = require("./frameworks");
/**
 * When writing JSON to the browser, we need to be careful that it doesn't get
 * interpretted as HTML.
 */
const JS_ESCAPE_LOOKUP = {
    '<': '\\u003c',
    '>': '\\u003e',
    '/': '\\u002f',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
};
function safeJSONStringify(obj) {
    return JSON.stringify(obj).replace(/[<>/\u2028\u2029]/g, chr => JS_ESCAPE_LOOKUP[chr]);
}
/**
 * When people webpack us up, e.g. for lambda, if they don't want GraphiQL then
 * they can seriously reduce bundle size by omitting the assets.
 */
const shouldOmitAssets = process.env.POSTGRAPHILE_OMIT_ASSETS === '1';
// Used by `createPostGraphileHttpRequestHandler`
let lastString;
let lastHash;
const calculateQueryHash = (queryString) => {
    if (queryString !== lastString) {
        lastString = queryString;
        lastHash = createHash('sha1').update(queryString).digest('base64');
    }
    return lastHash;
};
// Fast way of checking if an object is empty,
// faster than `Object.keys(value).length === 0`.
// NOTE: we don't need a `hasOwnProperty` call here because isEmpty is called
// with an `Object.create(null)` object, so it has no no-own properties.
/* tslint:disable forin */
function isEmpty(value) {
    for (const _key in value) {
        return false;
    }
    return true;
}
exports.isEmpty = isEmpty;
/* tslint:enable forin */
const isPostGraphileDevelopmentMode = process.env.POSTGRAPHILE_ENV === 'development';
const debugGraphql = Debugger('postgraphile:graphql');
const debugRequest = Debugger('postgraphile:request');
/**
 * We need to be able to share the withPostGraphileContext logic between HTTP
 * and websockets
 */
function withPostGraphileContextFromReqResGenerator(options) {
    const { pgSettings: pgSettingsGenerator, allowExplain: allowExplainGenerator, jwtSecret, jwtPublicKey, additionalGraphQLContextFromRequest, } = options;
    return async (req, res, moreOptions, fn) => {
        const jwtVerificationSecret = jwtPublicKey || jwtSecret;
        const jwtToken = jwtVerificationSecret ? getJwtToken(req) : null;
        const additionalContext = typeof additionalGraphQLContextFromRequest === 'function'
            ? await additionalGraphQLContextFromRequest(req, res)
            : null;
        const pgSettings = typeof pgSettingsGenerator === 'function'
            ? await pgSettingsGenerator(req)
            : pgSettingsGenerator;
        const allowExplain = typeof allowExplainGenerator === 'function'
            ? await allowExplainGenerator(req)
            : allowExplainGenerator;
        return withPostGraphileContext_1.default({
            ...options,
            jwtToken,
            pgSettings,
            explain: allowExplain && req.headers['x-postgraphile-explain'] === 'on',
            ...moreOptions,
        }, context => {
            const graphqlContext = additionalContext
                ? { ...additionalContext, ...context }
                : context;
            return fn(graphqlContext);
        });
    };
}
/**
 * Creates a GraphQL request handler that can support many different `http` frameworks, including:
 *
 * - Native Node.js `http`.
 * - `connect`.
 * - `express`.
 * - `koa` (2.0).
 */
function createPostGraphileHttpRequestHandler(options) {
    const MEGABYTE = 1024 * 1024;
    const subscriptions = !!options.subscriptions;
    const { getGqlSchema, pgPool, pgSettings, pgDefaultRole, shutdownActions, queryCacheMaxSize = 50 * MEGABYTE, extendedErrors, showErrorStack, watchPg, disableQueryLog, enableQueryBatching, websockets = options.subscriptions || options.live ? ['v0', 'v1'] : [], } = options;
    const live = !!options.live;
    const enhanceGraphiql = options.enhanceGraphiql === false ? false : !!options.enhanceGraphiql || subscriptions || live;
    const enableCors = !!options.enableCors || isPostGraphileDevelopmentMode;
    const graphiql = options.graphiql === true;
    if (options['absoluteRoutes']) {
        throw new Error('Sorry - the `absoluteRoutes` setting has been replaced with `externalUrlBase` which solves the issue in a cleaner way. Please update your settings. Thank you for testing a PostGraphile pre-release 🙏');
    }
    // Using let because we might override it on the first request.
    let externalUrlBase = options.externalUrlBase;
    if (externalUrlBase && externalUrlBase.endsWith('/')) {
        throw new Error('externalUrlBase must not end with a slash (`/`)');
    }
    // Validate websockets argument
    if (
    // must be array
    !Array.isArray(websockets) ||
        // empty array = 'none'
        (websockets.length &&
            // array can only hold the versions
            websockets.some(ver => !['v0', 'v1'].includes(ver)))) {
        throw new Error(`Invalid value for \`websockets\` option: '${websockets}'`);
    }
    const pluginHook = pluginHook_1.pluginHookFromOptions(options);
    const origGraphiqlHtml = pluginHook('postgraphile:graphiql:html', graphiql_html_1.default, { options });
    if (pgDefaultRole && typeof pgSettings === 'function') {
        throw new Error('pgDefaultRole cannot be combined with pgSettings(req) - please remove pgDefaultRole and instead always return a `role` key from pgSettings(req).');
    }
    if (pgDefaultRole &&
        pgSettings &&
        typeof pgSettings === 'object' &&
        Object.keys(pgSettings)
            .map(s => s.toLowerCase())
            .includes('role')) {
        throw new Error('pgDefaultRole cannot be combined with pgSettings.role - please use one or the other.');
    }
    if (graphiql && shouldOmitAssets) {
        throw new Error('Cannot enable GraphiQL when POSTGRAPHILE_OMIT_ASSETS is set');
    }
    // Gets the route names for our GraphQL endpoint, and our GraphiQL endpoint.
    const graphqlRoute = options.graphqlRoute || '/graphql';
    const graphiqlRoute = options.graphiqlRoute || '/graphiql';
    // Set the request credential behavior in graphiql.
    const graphiqlCredentials = options.graphiqlCredentials || 'same-origin';
    const eventStreamRoute = options.eventStreamRoute || `${graphqlRoute.replace(/\/+$/, '')}/stream`;
    const externalGraphqlRoute = options.externalGraphqlRoute;
    const externalEventStreamRoute = options.externalEventStreamRoute ||
        (externalGraphqlRoute && !options.eventStreamRoute
            ? `${externalGraphqlRoute.replace(/\/+$/, '')}/stream`
            : undefined);
    // Throw an error of the GraphQL and GraphiQL routes are the same.
    if (graphqlRoute === graphiqlRoute)
        throw new Error(`Cannot use the same route, '${graphqlRoute}', for both GraphQL and GraphiQL. Please use different routes.`);
    // Formats an error using the default GraphQL `formatError` function, and
    // custom formatting using some other options.
    const formatError = (error) => {
        // Get the appropriate formatted error object, including any extended error
        // fields if the user wants them.
        const formattedError = extendedErrors && extendedErrors.length
            ? extendedFormatError_1.extendedFormatError(error, extendedErrors)
            : graphql_1.formatError(error);
        // If the user wants to see the error’s stack, let’s add it to the
        // formatted error.
        if (showErrorStack)
            formattedError['stack'] =
                error.stack != null && showErrorStack === 'json' ? error.stack.split('\n') : error.stack;
        return formattedError;
    };
    const DEFAULT_HANDLE_ERRORS = (errors) => errors.map(formatError);
    const handleErrors = options.handleErrors || DEFAULT_HANDLE_ERRORS;
    // Define a list of middlewares that will get run before our request handler.
    // Note though that none of these middlewares will intercept a request (i.e.
    // not call `next`). Middlewares that handle a request like favicon
    // middleware will result in a promise that never resolves, and we don’t
    // want that.
    const bodyParserMiddlewares = [
        // Parse JSON bodies.
        bodyParser.json({ limit: options.bodySizeLimit }),
        // Parse URL encoded bodies (forms).
        bodyParser.urlencoded({ extended: false, limit: options.bodySizeLimit }),
        // Parse `application/graphql` content type bodies as text.
        bodyParser.text({ type: 'application/graphql', limit: options.bodySizeLimit }),
    ];
    // We'll turn this into one function now so it can be better JIT optimised
    const bodyParserMiddlewaresComposed = bodyParserMiddlewares.reduce((parent, fn) => {
        return (req, res, next) => {
            parent(req, res, error => {
                if (error) {
                    return next(error);
                }
                fn(req, res, next);
            });
        };
    }, (_req, _res, next) => next());
    // And we really want that function to be await-able
    const parseBody = (req, res) => new Promise((resolve, reject) => {
        bodyParserMiddlewaresComposed(req, 
        // Note: middleware here doesn't actually use the response, but we pass
        // the underlying value so types match up.
        res.getNodeServerResponse(), (error) => {
            if (error) {
                reject(error);
            }
            else {
                resolve();
            }
        });
    });
    // We only need to calculate the graphiql HTML once; but we need to receive the first request to do so.
    let graphiqlHtml;
    const withPostGraphileContextFromReqRes = withPostGraphileContextFromReqResGenerator(options);
    const staticValidationRules = pluginHook('postgraphile:validationRules:static', graphql_1.specifiedRules, {
        options,
    });
    const cacheSize = Math.ceil(queryCacheMaxSize / CACHE_MULTIPLIER);
    // Do not create an LRU for cache size < 2 because @graphile/lru will baulk.
    const cacheEnabled = cacheSize >= 2;
    const queryCache = cacheEnabled ? new lru_1.default({ maxLength: cacheSize }) : null;
    let lastGqlSchema;
    const parseQuery = (gqlSchema, queryString) => {
        if (gqlSchema !== lastGqlSchema) {
            if (queryCache) {
                queryCache.reset();
            }
            lastGqlSchema = gqlSchema;
        }
        // Only cache queries that are less than 100kB, we don't want DOS attacks
        // attempting to exhaust our memory.
        const canCache = cacheEnabled && queryString.length < 100000;
        const hash = canCache ? calculateQueryHash(queryString) : null;
        const result = canCache ? queryCache.get(hash) : null;
        if (result) {
            return result;
        }
        else {
            const source = new graphql_1.Source(queryString, 'GraphQL Http Request');
            let queryDocumentAst;
            // Catch an errors while parsing so that we can set the `statusCode` to
            // 400. Otherwise we don’t need to parse this way.
            try {
                queryDocumentAst = graphql_1.parse(source);
            }
            catch (error) {
                error.statusCode = 400;
                throw error;
            }
            if (debugRequest.enabled)
                debugRequest('GraphQL query is parsed.');
            // Validate our GraphQL query using given rules.
            const validationErrors = graphql_1.validate(gqlSchema, queryDocumentAst, staticValidationRules);
            const cacheResult = {
                queryDocumentAst,
                validationErrors,
                length: queryString.length,
            };
            if (canCache) {
                queryCache.set(hash, cacheResult);
            }
            return cacheResult;
        }
    };
    let firstRequestHandler = req => {
        // Never be called again
        firstRequestHandler = null;
        let graphqlRouteForWs = graphqlRoute;
        const { pathname = '' } = parseUrl(req) || {};
        const { pathname: originalPathname = '' } = parseUrl.original(req) || {};
        if (originalPathname !== pathname && originalPathname.endsWith(pathname)) {
            const base = originalPathname.slice(0, originalPathname.length - pathname.length);
            // Our websocket GraphQL route must be at a different place
            graphqlRouteForWs = base + graphqlRouteForWs;
            if (externalUrlBase == null) {
                // User hasn't specified externalUrlBase; let's try and guess it
                // We were mounted on a subpath (e.g. `app.use('/path/to', postgraphile(...))`).
                // Figure out our externalUrlBase for ourselves.
                externalUrlBase = base;
            }
        }
        // Make sure we have a string, at least
        externalUrlBase = externalUrlBase || '';
        // Takes the original GraphiQL HTML file and replaces the default config object.
        graphiqlHtml = origGraphiqlHtml
            ? origGraphiqlHtml.replace(/<\/head>/, `  <script>window.POSTGRAPHILE_CONFIG=${safeJSONStringify({
                graphqlUrl: externalGraphqlRoute || `${externalUrlBase}${graphqlRoute}`,
                streamUrl: watchPg
                    ? externalEventStreamRoute || `${externalUrlBase}${eventStreamRoute}`
                    : null,
                enhanceGraphiql,
                // if 'v1' websockets are included, use the v1 client always
                websockets: !websockets.length ? 'none' : websockets.includes('v1') ? 'v1' : 'v0',
                allowExplain: typeof options.allowExplain === 'function'
                    ? ALLOW_EXPLAIN_PLACEHOLDER
                    : !!options.allowExplain,
                credentials: graphiqlCredentials,
            })};</script>\n  </head>`)
            : null;
        if (websockets.length) {
            const server = req && req.connection && req.connection['server'];
            if (!server) {
                // tslint:disable-next-line no-console
                console.warn("Failed to find server to add websocket listener to, you'll need to call `enhanceHttpServerWithWebSockets` manually");
            }
            else {
                // Relying on this means that a normal request must come in before an
                // upgrade attempt. It's better to call it manually.
                subscriptions_1.enhanceHttpServerWithWebSockets(server, middleware, {
                    graphqlRoute: graphqlRouteForWs,
                });
            }
        }
    };
    /*
     * If we're not in watch mode, then avoid the cost of `await`ing the schema
     * on every tick by having it available once it was generated.
     */
    let theOneAndOnlyGraphQLSchema = null;
    if (!watchPg) {
        getGqlSchema()
            .then(schema => {
            theOneAndOnlyGraphQLSchema = schema;
        })
            .catch(noop);
    }
    function neverReject(middlewareName, middleware) {
        return async (res) => {
            try {
                await middleware(res);
            }
            catch (e) {
                console.error(`An unexpected error occurred whilst processing '${middlewareName}'; this indicates a bug. The connection will be terminated.`);
                console.error(e);
                try {
                    // At least terminate the connection
                    res.statusCode = 500;
                    res.end();
                }
                catch (e) {
                    /*NOOP*/
                }
            }
        };
    }
    /**
     * The actual request handler. It’s an async function so it will return a
     * promise when complete. If the function doesn’t handle anything, it calls
     * `next` to let the next middleware try and handle it. If the function
     * throws an error, it's up to the wrapping middleware (imaginatively named
     * `middleware`, below) to handle the error. Frameworks like Koa have
     * middlewares reject a promise on error, whereas Express requires you pass
     * the error to the `next(err)` function.
     */
    const requestHandler = async (responseHandler, next) => {
        const res = responseHandler;
        const incomingReq = res.getNodeServerRequest();
        const nodeRes = res.getNodeServerResponse();
        // You can use this hook either to modify the incoming request or to tell
        // PostGraphile not to handle the request further (return null). NOTE: if
        // you return `null` from this hook then you are also responsible for
        // calling `next()` (should that be required).
        const req = pluginHook('postgraphile:http:handler', incomingReq, {
            options,
            res: nodeRes,
            next,
        });
        if (req == null) {
            return;
        }
        const { pathname = '' } = parseUrl(req) || {};
        // Certain things depend on externalUrlBase, which we guess if the user
        // doesn't supply it, so we calculate them on the first request. After
        // first request, this function becomes a NOOP
        if (firstRequestHandler)
            firstRequestHandler(req);
        // ======================================================================
        // GraphQL Watch Stream
        // ======================================================================
        if (watchPg) {
            // Setup an event stream so we can broadcast events to graphiql, etc.
            if (pathname === eventStreamRoute || pathname === '/_postgraphile/stream') {
                return eventStreamRouteHandler(res);
            }
        }
        const isGraphqlRoute = pathname === graphqlRoute;
        // ========================================================================
        // Serve GraphiQL and Related Assets
        // ========================================================================
        if (!shouldOmitAssets && graphiql && !isGraphqlRoute) {
            // ======================================================================
            // Favicon
            // ======================================================================
            // If this is the favicon path and it has not yet been handled, let us
            // serve our GraphQL favicon.
            if (pathname === '/favicon.ico') {
                return faviconRouteHandler(res);
            }
            // ======================================================================
            // GraphiQL HTML
            // ======================================================================
            // If this is the GraphiQL route, show GraphiQL and stop execution.
            if (pathname === graphiqlRoute) {
                // If we are developing PostGraphile, instead just redirect.
                if (isPostGraphileDevelopmentMode) {
                    res.statusCode = 302;
                    res.setHeader('Location', 'http://localhost:5783');
                    res.end();
                    return;
                }
                return graphiqlRouteHandler(res);
            }
        }
        if (isGraphqlRoute) {
            return graphqlRouteHandler(res);
        }
        else {
            // This request wasn't for us.
            return next();
        }
    };
    const eventStreamRouteHandler = neverReject('eventStreamRouteHandler', async function eventStreamRouteHandler(res) {
        try {
            // You can use this hook either to modify the incoming request or to tell
            // PostGraphile not to handle the request further (return null). NOTE: if
            // you return `null` from this hook then you are also responsible for
            // terminating the request however your framework handles that (e.g.
            // `res.send(...)` or `next()`).
            const req = pluginHook('postgraphile:http:eventStreamRouteHandler', res.getNodeServerRequest(), { options, response: res });
            if (req == null) {
                return;
            }
            // Add our CORS headers to be good web citizens (there are perf
            // implications though so be careful!)
            //
            // Always enable CORS when developing PostGraphile because GraphiQL will be
            // on port 5783.
            if (enableCors)
                addCORSHeaders(res);
            if (req.headers.accept !== 'text/event-stream') {
                res.statusCode = 405;
                res.end();
                return;
            }
            setupServerSentEvents_1.default(res, options);
        }
        catch (e) {
            console.error('Unexpected error occurred in eventStreamRouteHandler');
            console.error(e);
            res.statusCode = 500;
            res.end();
        }
    });
    const faviconRouteHandler = neverReject('faviconRouteHandler', async function faviconRouteHandler(res) {
        // You can use this hook either to modify the incoming request or to tell
        // PostGraphile not to handle the request further (return null). NOTE: if
        // you return `null` from this hook then you are also responsible for
        // terminating the request however your framework handles that (e.g.
        // `res.send(...)` or `next()`).
        const req = pluginHook('postgraphile:http:faviconRouteHandler', res.getNodeServerRequest(), {
            options,
            response: res,
        });
        if (req == null) {
            return;
        }
        // If this is the wrong method, we should let the client know.
        if (!(req.method === 'GET' || req.method === 'HEAD')) {
            res.statusCode = req.method === 'OPTIONS' ? 200 : 405;
            res.setHeader('Allow', 'GET, HEAD, OPTIONS');
            res.end();
            return;
        }
        // Otherwise we are good and should pipe the favicon to the browser.
        res.statusCode = 200;
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Content-Type', 'image/x-icon');
        // End early if the method is `HEAD`.
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        res.end(favicon_ico_1.default);
    });
    const graphiqlRouteHandler = neverReject('graphiqlRouteHandler', async function graphiqlRouteHandler(res) {
        // You can use this hook either to modify the incoming request or to tell
        // PostGraphile not to handle the request further (return null). NOTE: if
        // you return `null` from this hook then you are also responsible for
        // terminating the request however your framework handles that (e.g.
        // `res.send(...)` or `next()`).
        const req = pluginHook('postgraphile:http:graphiqlRouteHandler', res.getNodeServerRequest(), {
            options,
            response: res,
        });
        if (req == null) {
            return;
        }
        if (firstRequestHandler)
            firstRequestHandler(req);
        // If using the incorrect method, let the user know.
        if (!(req.method === 'GET' || req.method === 'HEAD')) {
            res.statusCode = req.method === 'OPTIONS' ? 200 : 405;
            res.setHeader('Allow', 'GET, HEAD, OPTIONS');
            res.end();
            return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
        // End early if the method is `HEAD`.
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        // Actually renders GraphiQL.
        if (graphiqlHtml && typeof options.allowExplain === 'function') {
            res.end(graphiqlHtml.replace(`"${ALLOW_EXPLAIN_PLACEHOLDER}"`, // Because JSON escaped
            JSON.stringify(!!(await options.allowExplain(req)))));
        }
        else {
            res.end(graphiqlHtml);
        }
    });
    const graphqlRouteHandler = neverReject('graphqlRouteHandler', async function graphqlRouteHandler(res) {
        // You can use this hook either to modify the incoming request or to tell
        // PostGraphile not to handle the request further (return null). NOTE: if
        // you return `null` from this hook then you are also responsible for
        // terminating the request however your framework handles that (e.g.
        // `res.send(...)` or `next()`).
        const req = pluginHook('postgraphile:http:graphqlRouteHandler', res.getNodeServerRequest(), {
            options,
            response: res,
        });
        if (req == null) {
            return;
        }
        if (firstRequestHandler)
            firstRequestHandler(req);
        // Add our CORS headers to be good web citizens (there are perf
        // implications though so be careful!)
        //
        // Always enable CORS when developing PostGraphile because GraphiQL will be
        // on port 5783.
        if (enableCors)
            addCORSHeaders(res);
        // ========================================================================
        // Execute GraphQL Queries
        // ========================================================================
        // If we didn’t call `next` above, all requests will return 200 by default!
        res.statusCode = 200;
        if (watchPg) {
            // Inform GraphiQL and other clients that they can subscribe to events
            // (such as the schema being updated) at the following URL
            res.setHeader('X-GraphQL-Event-Stream', externalEventStreamRoute || `${externalUrlBase}${eventStreamRoute}`);
        }
        // Don’t execute our GraphQL stuffs for `OPTIONS` requests.
        if (req.method === 'OPTIONS') {
            res.statusCode = 200;
            res.end();
            return;
        }
        // The `result` will be used at the very end in our `finally` block.
        // Statements inside the `try` will assign to `result` when they get
        // a result. We also keep track of `params`.
        let paramsList;
        let results = [];
        const queryTimeStart = !disableQueryLog && process.hrtime();
        let pgRole;
        if (debugRequest.enabled)
            debugRequest('GraphQL query request has begun.');
        let returnArray = false;
        // This big `try`/`catch`/`finally` block represents the execution of our
        // GraphQL query. All errors thrown in this block will be returned to the
        // client as GraphQL errors.
        try {
            // First thing we need to do is get the GraphQL schema for this request.
            // It should never really change unless we are in watch mode.
            const gqlSchema = theOneAndOnlyGraphQLSchema || (await getGqlSchema());
            // Note that we run our middleware after we make sure we are on the
            // correct route. This is so that if our middleware modifies the `req` or
            // `res` objects, only we downstream will see the modifications.
            //
            // We also run our middleware inside the `try` so that we get the GraphQL
            // error reporting style for syntax errors.
            await parseBody(req, res);
            // If this is not one of the correct methods, throw an error.
            if (req.method !== 'POST') {
                res.setHeader('Allow', 'POST, OPTIONS');
                throw httpError(405, 'Only `POST` requests are allowed.');
            }
            // Get the parameters we will use to run a GraphQL request. `params` may
            // include:
            //
            // - `query`: The required GraphQL query string.
            // - `variables`: An optional JSON object containing GraphQL variables.
            // - `operationName`: The optional name of the GraphQL operation we will
            //   be executing.
            const body = req.body;
            paramsList = typeof body === 'string' ? { query: body } : body;
            // Validate our paramsList object a bit.
            if (paramsList == null)
                throw httpError(400, 'Must provide an object parameters, not nullish value.');
            if (typeof paramsList !== 'object')
                throw httpError(400, `Expected parameter object, not value of type '${typeof paramsList}'.`);
            if (Array.isArray(paramsList)) {
                if (!enableQueryBatching) {
                    throw httpError(501, 'Batching queries as an array is currently unsupported. Please provide a single query object.');
                }
                else {
                    returnArray = true;
                }
            }
            else {
                paramsList = [paramsList];
            }
            paramsList = pluginHook('postgraphile:httpParamsList', paramsList, {
                options,
                req,
                res,
                returnArray,
                httpError,
            });
            results = await Promise.all(paramsList.map(async (params) => {
                let queryDocumentAst = null;
                let result;
                const meta = Object.create(null);
                try {
                    if (!params)
                        throw httpError(400, 'Invalid query structure.');
                    const { query, operationName } = params;
                    let { variables } = params;
                    if (!query)
                        throw httpError(400, 'Must provide a query string.');
                    // If variables is a string, we assume it is a JSON string and that it
                    // needs to be parsed.
                    if (typeof variables === 'string') {
                        // If variables is just an empty string, we should set it to null and
                        // ignore it.
                        if (variables === '') {
                            variables = null;
                        }
                        else {
                            // Otherwise, let us try to parse it as JSON.
                            try {
                                variables = JSON.parse(variables);
                            }
                            catch (error) {
                                error.statusCode = 400;
                                throw error;
                            }
                        }
                    }
                    // Throw an error if `variables` is not an object.
                    if (variables != null && typeof variables !== 'object')
                        throw httpError(400, `Variables must be an object, not '${typeof variables}'.`);
                    // Throw an error if `operationName` is not a string.
                    if (operationName != null && typeof operationName !== 'string')
                        throw httpError(400, `Operation name must be a string, not '${typeof operationName}'.`);
                    let validationErrors;
                    ({ queryDocumentAst, validationErrors } = parseQuery(gqlSchema, query));
                    if (validationErrors.length === 0) {
                        // You are strongly encouraged to use
                        // `postgraphile:validationRules:static` if possible - you should
                        // only use this one if you need access to variables.
                        const moreValidationRules = pluginHook('postgraphile:validationRules', [], {
                            options,
                            req,
                            res,
                            variables,
                            operationName,
                            meta,
                        });
                        if (moreValidationRules.length) {
                            validationErrors = graphql_1.validate(gqlSchema, queryDocumentAst, moreValidationRules);
                        }
                    }
                    // If we have some validation errors, don’t execute the query. Instead
                    // send the errors to the client with a `400` code.
                    if (validationErrors.length > 0) {
                        result = { errors: validationErrors, statusCode: 400 };
                    }
                    else if (!queryDocumentAst) {
                        throw new Error('Could not process query');
                    }
                    else {
                        if (debugRequest.enabled)
                            debugRequest('GraphQL query is validated.');
                        // Lazily log the query. If this debugger isn’t enabled, don’t run it.
                        if (debugGraphql.enabled)
                            debugGraphql('%s', graphql_1.print(queryDocumentAst).replace(/\s+/g, ' ').trim());
                        result = await withPostGraphileContextFromReqRes(req, 
                        // For backwards compatibilty we must pass the actual node request object.
                        res.getNodeServerResponse(), {
                            singleStatement: false,
                            queryDocumentAst,
                            variables,
                            operationName,
                        }, (graphqlContext) => {
                            pgRole = graphqlContext.pgRole;
                            const graphqlResult = graphql_1.execute(gqlSchema, queryDocumentAst, null, graphqlContext, variables, operationName);
                            if (typeof graphqlContext.getExplainResults === 'function') {
                                return Promise.resolve(graphqlResult).then(async (obj) => ({
                                    ...obj,
                                    // Add our explain data
                                    explain: await graphqlContext.getExplainResults(),
                                }));
                            }
                            else {
                                return graphqlResult;
                            }
                        });
                    }
                }
                catch (error) {
                    result = {
                        errors: [error],
                        statusCode: error.status || error.statusCode || 500,
                    };
                    // If the status code is 500, let’s log our error.
                    if (result.statusCode === 500)
                        // tslint:disable-next-line no-console
                        console.error(error.stack);
                }
                finally {
                    // Format our errors so the client doesn’t get the full thing.
                    if (result && result.errors) {
                        result.errors = handleErrors(result.errors, req, res);
                    }
                    if (!isEmpty(meta)) {
                        result.meta = meta;
                    }
                    result = pluginHook('postgraphile:http:result', result, {
                        options,
                        returnArray,
                        queryDocumentAst,
                        req,
                        pgRole,
                    });
                    // Log the query. If this debugger isn’t enabled, don’t run it.
                    if (!disableQueryLog && queryDocumentAst) {
                        // To appease TypeScript
                        const definitelyQueryDocumentAst = queryDocumentAst;
                        // We must reference this before it's deleted!
                        const resultStatusCode = result.statusCode;
                        const timeDiff = queryTimeStart && process.hrtime(queryTimeStart);
                        setImmediate(() => {
                            const prettyQuery = graphql_1.print(definitelyQueryDocumentAst)
                                .replace(/\s+/g, ' ')
                                .trim();
                            const errorCount = (result.errors || []).length;
                            const ms = timeDiff[0] * 1e3 + timeDiff[1] * 1e-6;
                            let message;
                            if (resultStatusCode === 401) {
                                // Users requested that JWT errors were raised differently:
                                //
                                //   https://github.com/graphile/postgraphile/issues/560
                                message = chalk_1.default.red(`401 authentication error`);
                            }
                            else if (resultStatusCode === 403) {
                                message = chalk_1.default.red(`403 forbidden error`);
                            }
                            else {
                                message = chalk_1.default[errorCount === 0 ? 'green' : 'red'](`${errorCount} error(s)`);
                            }
                            // tslint:disable-next-line no-console
                            console.log(`${message} ${pgRole != null ? `as ${chalk_1.default.magenta(pgRole)} ` : ''}in ${chalk_1.default.grey(`${ms.toFixed(2)}ms`)} :: ${prettyQuery}`);
                        });
                    }
                    if (debugRequest.enabled)
                        debugRequest('GraphQL query has been executed.');
                }
                return result;
            }));
        }
        catch (error) {
            // Set our status code and send the client our results!
            if (res.statusCode === 200)
                res.statusCode = error.status || error.statusCode || 500;
            // Overwrite entire response
            returnArray = false;
            results = [{ errors: handleErrors([error], req, res) }];
            // If the status code is 500, let’s log our error.
            if (res.statusCode === 500) {
                // tslint:disable-next-line no-console
                console.error(error.stack);
            }
        }
        finally {
            // Finally, we send the client the results.
            if (!returnArray) {
                if (res.statusCode === 200 && results[0].statusCode) {
                    res.statusCode = results[0].statusCode;
                }
                results[0].statusCode = undefined;
            }
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            const { statusCode, result } = pluginHook('postgraphile:http:end', {
                statusCode: res.statusCode,
                result: returnArray ? results : results[0],
            }, {
                options,
                returnArray,
                req,
                // For backwards compatibility, the underlying response object.
                res: res.getNodeServerResponse(),
            });
            if (statusCode) {
                res.statusCode = statusCode;
            }
            res.end(JSON.stringify(result));
            if (debugRequest.enabled) {
                debugRequest('GraphQL ' + (returnArray ? 'queries' : 'query') + ' request finished.');
            }
        }
    });
    /**
     * A polymorphic request handler that should detect what `http` framework is
     * being used and specifically handle that framework.
     *
     * Supported frameworks include:
     *
     * - Native Node.js `http`.
     * - `connect`.
     * - `express`.
     * - `koa` (2.0).
     */
    const middleware = (a, b, c) => {
        // If are arguments look like the arguments to koa middleware, this is
        // `koa` middleware.
        if (isKoaApp(a, b)) {
            // Set the correct `koa` variable names…
            const ctx = a;
            const next = b;
            const responseHandler = new frameworks_1.PostGraphileResponseKoa(ctx, next);
            // Execute our request handler. If an error is thrown, we don’t call
            // `next` with an error. Instead we return the promise and let `koa`
            // handle the error.
            return requestHandler(responseHandler, next);
        }
        else {
            // Set the correct `connect` style variable names. If there was no `next`
            // defined (likely the case if the client is using `http`) we use the
            // final handler.
            const req = a;
            const res = b;
            const next = c || finalHandler(req, res);
            const responseHandler = new frameworks_1.PostGraphileResponseNode(req, res, next);
            // Execute our request handler. If the request errored out, call `next` with the error.
            requestHandler(responseHandler, next).catch(next);
            // No return value.
        }
    };
    middleware.getGraphQLSchema = getGqlSchema;
    middleware.formatError = formatError;
    middleware.pgPool = pgPool;
    middleware.withPostGraphileContextFromReqRes = withPostGraphileContextFromReqRes;
    middleware.handleErrors = handleErrors;
    middleware.options = options;
    middleware.graphqlRoute = graphqlRoute;
    middleware.graphqlRouteHandler = graphqlRouteHandler;
    middleware.graphiqlRoute = graphiqlRoute;
    middleware.graphiqlRouteHandler = graphiql ? graphiqlRouteHandler : null;
    middleware.faviconRouteHandler = graphiql ? faviconRouteHandler : null;
    middleware.eventStreamRoute = eventStreamRoute;
    middleware.eventStreamRouteHandler = watchPg ? eventStreamRouteHandler : null;
    middleware.shutdownActions = shutdownActions;
    // Experimental
    middleware.release = () => shutdownActions.invokeAll();
    const hookedMiddleware = pluginHook('postgraphile:middleware', middleware, {
        options,
        // Experimental
        shutdownActions,
    });
    // Sanity check:
    if (!hookedMiddleware.getGraphQLSchema) {
        throw new Error("Hook for 'postgraphile:middleware' has not copied over the helpers; e.g. missing `Object.assign(newMiddleware, oldMiddleware)`");
    }
    return hookedMiddleware;
}
exports.default = createPostGraphileHttpRequestHandler;
/**
 * Adds CORS to a request. See [this][1] flowchart for an explanation of how
 * CORS works. Note that these headers are set for all requests, CORS
 * algorithms normally run a preflight request using the `OPTIONS` method to
 * get these headers.
 *
 * Note though, that enabling CORS will incur extra costs when it comes to the
 * preflight requests. It is much better if you choose to use a proxy and
 * bypass CORS altogether.
 *
 * [1]: http://www.html5rocks.com/static/images/cors_server_flowchart.png
 */
function addCORSHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'HEAD, GET, POST');
    res.setHeader('Access-Control-Allow-Headers', [
        'Origin',
        'X-Requested-With',
        // Used by `express-graphql` to determine whether to expose the GraphiQL
        // interface (`text/html`) or not.
        'Accept',
        // Used by PostGraphile for auth purposes.
        'Authorization',
        // Used by GraphQL Playground and other Apollo-enabled servers
        'X-Apollo-Tracing',
        // The `Content-*` headers are used when making requests with a body,
        // like in a POST request.
        'Content-Type',
        'Content-Length',
        // For our 'Explain' feature
        'X-PostGraphile-Explain',
    ].join(', '));
    res.setHeader('Access-Control-Expose-Headers', ['X-GraphQL-Event-Stream'].join(', '));
}
function createBadAuthorizationHeaderError() {
    return httpError(400, 'Authorization header is not of the correct bearer scheme format.');
}
/**
 * Parses the `Bearer` auth scheme token out of the `Authorization` header as
 * defined by [RFC7235][1].
 *
 * ```
 * Authorization = credentials
 * credentials   = auth-scheme [ 1*SP ( token68 / #auth-param ) ]
 * token68       = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" )*"="
 * ```
 *
 * [1]: https://tools.ietf.org/html/rfc7235
 *
 * @private
 */
const authorizationBearerRex = /^\s*bearer\s+([a-z0-9\-._~+/]+=*)\s*$/i;
/**
 * Gets the JWT token from the Http request’s headers. Specifically the
 * `Authorization` header in the `Bearer` format. Will throw an error if the
 * header is in the incorrect format, but will not throw an error if the header
 * does not exist.
 *
 * @private
 * @param {IncomingMessage} request
 * @returns {string | null}
 */
function getJwtToken(request) {
    const { authorization } = request.headers;
    if (Array.isArray(authorization))
        throw createBadAuthorizationHeaderError();
    // If there was no authorization header, just return null.
    if (authorization == null)
        return null;
    const match = authorizationBearerRex.exec(authorization);
    // If we did not match the authorization header with our expected format,
    // throw a 400 error.
    if (!match)
        throw createBadAuthorizationHeaderError();
    // Return the token from our match.
    return match[1];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3JlYXRlUG9zdEdyYXBoaWxlSHR0cFJlcXVlc3RIYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vc3JjL3Bvc3RncmFwaGlsZS9odHRwL2NyZWF0ZVBvc3RHcmFwaGlsZUh0dHBSZXF1ZXN0SGFuZGxlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSw4RUFBOEU7QUFDOUUscUNBV2lCO0FBQ2pCLGdFQUE2RDtBQUU3RCw4Q0FBc0Q7QUFFdEQsbUVBQTREO0FBQzVELHdFQUFpRTtBQUNqRSx1Q0FBZ0M7QUFFaEMsaUNBQTBCO0FBQzFCLGtDQUFtQyxDQUFDLG9DQUFvQztBQUN4RSx5Q0FBMEM7QUFDMUMscUNBQXNDO0FBQ3RDLDZDQUE4QztBQUM5QywwQ0FBMkM7QUFDM0MsaUNBQWtDO0FBRWxDLE1BQU0sUUFBUSxHQUFHLENBQUMsQ0FBTSxFQUFFLENBQU0sRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLENBQUMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxLQUFLLFVBQVUsQ0FBQztBQUUvRSxNQUFNLGdCQUFnQixHQUFHLE1BQU0sQ0FBQztBQUVoQyxNQUFNLHlCQUF5QixHQUFHLDBCQUEwQixDQUFDO0FBQzdELE1BQU0sSUFBSSxHQUFHLEdBQUcsRUFBRTtJQUNoQixVQUFVO0FBQ1osQ0FBQyxDQUFDO0FBRUYsTUFBTSxFQUFFLFVBQVUsRUFBRSxHQUFHLE1BQU0sQ0FBQztBQUU5Qjs7Ozs7R0FLRztBQUNILDBEQUErQztBQUUvQzs7O0dBR0c7QUFDSCw4REFBMEQ7QUFDMUQsbURBQWtFO0FBQ2xFLDZDQU1zQjtBQUV0Qjs7O0dBR0c7QUFDSCxNQUFNLGdCQUFnQixHQUFHO0lBQ3ZCLEdBQUcsRUFBRSxTQUFTO0lBQ2QsR0FBRyxFQUFFLFNBQVM7SUFDZCxHQUFHLEVBQUUsU0FBUztJQUNkLFFBQVEsRUFBRSxTQUFTO0lBQ25CLFFBQVEsRUFBRSxTQUFTO0NBQ3BCLENBQUM7QUFDRixT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