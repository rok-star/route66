import { ServerRequest } from 'https://deno.land/std/http/server.ts'
import * as Path from 'https://deno.land/std@0.85.0/path/mod.ts'
import * as FS from 'https://deno.land/std@0.85.0/fs/mod.ts'

const MIMETYPE: Record<string, string> = {
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.json': 'application/json',
    '.map': 'application/json',
    '.txt': 'text/plain',
    '.ts': 'text/typescript',
    '.tsx': 'text/tsx',
    '.js': 'application/javascript',
    '.jsx': 'text/jsx',
    '.gz': 'application/gzip',
    '.css': 'text/css',
    '.wasm': 'application/wasm',
    '.mjs': 'application/javascript',
};

export class JSONParseError extends Error {
    public constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, JSONParseError.prototype);
    }
}

export class UnsupportedMediaTypeError extends Error {
    public constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, UnsupportedMediaTypeError.prototype);
    }
}

type RouterMethod = ('GET' | 'POST' | 'PATCH' | 'DELETE' | 'OPTIONS');
type RouterItemPart = { name: string, param: boolean };

class RouterItem<T> {
    private _method: RouterMethod;
    private _pattern: string;
    private _handlers: RouterHandler<T>[];
    private _parts: RouterItemPart[];
    private _variadic: boolean;
    public get method(): RouterMethod {
        return this._method;
    };
    public get pattern(): Readonly<string> {
        return this._pattern;
    };
    public get handlers(): Readonly<RouterHandler<T>[]> {
        return this._handlers;
    };
    public get parts(): Readonly<RouterItemPart[]> {
        return this._parts;
    };
    public get variadic(): boolean {
        return this._variadic;
    };
    public constructor(method: RouterMethod, pattern: string, head: RouterHandler<T>, ...tail: RouterHandler<T>[]) {
        if (pattern.length === 0) {
            throw new Error('pattern length must be greater than 0');
        }

        if (pattern.indexOf('*') !== pattern.lastIndexOf('*')) {
            throw new Error(`wrong pattern "${pattern}"`);
        }

        this._method = method;
        this._pattern = pattern;
        this._handlers = [head, ...tail];
        this._variadic = pattern.includes('*');
        this._parts = [];

        for (const part of pattern.split('/').filter(i => !!i)) {
            if (part.includes(':')) {
                if ((part.indexOf(':') === 0)
                && (part.lastIndexOf(':') === 0)) {
                    this._parts.push({ name: part.slice(1), param: true });
                } else {
                    throw new Error(`wrong pattern "${pattern}"`);
                }
            } else if (part.includes('*')) {
                if (part.length === 1) {
                    this._parts.push({ name: '*', param: true });
                } else {
                    throw new Error(`wrong pattern "${pattern}"`);
                }
            } else {
                this._parts.push({ name: part, param: false });
            }
        }
    }
    public conflicts(item: RouterItem<T>): boolean {
        if (this._method !== item._method) {
            return false;
        } else {
            for (let i = 0; i < Math.max(this._parts.length, item._parts.length); i++) {
                const lpart = this._parts[i];
                const rpart = item._parts[i];

                if ((lpart === undefined)
                || (rpart === undefined)) {
                    return false;
                }

                if ((lpart.name === '*')
                || (rpart.name === '*')) {
                    return true;
                }

                if (lpart.param || rpart.param) {
                    continue;
                }
                if (lpart.name !== rpart.name) {
                    return false;
                }
            }

            return true;
        }
    }
    public matches(method: string, parts: string[]): { matches: boolean, params: Record<string, string> } {
        if (method.toUpperCase() === this._method) {
            if (((this._parts.length === parts.length) && !this._variadic)
            || ((this._parts.length <= parts.length) && this._variadic)) {
                const params: Record<string, string> = {};
                for (let i = 0; i < this._parts.length; i++) {
                    const lpart = this._parts[i];
                    const rpart = parts[i];
                    if (lpart.param) {
                        if (lpart.name === '*') {
                            params[lpart.name] = parts.slice(i).join('/');
                        } else {
                            params[lpart.name] = rpart;
                        }
                    } else {
                        if (lpart.name !== rpart) {
                            return { matches: false, params: {} }
                        }
                    }
                }
                return { matches: true, params };
            } else {
                return { matches: false, params: {} };
            }
        } else {
            return { matches: false, params: {} };
        }
    }
}

export type RouterHandler<T> = (context: RouterContext<T>, next: () => void) => (Promise<void> | void);

export class RouterContext<T> {
    private _req: ServerRequest;
    private _props: T;
    private _params: Record<string, string>;
    public get req(): ServerRequest {
        return this._req;
    }
    public get props(): T {
        return this._props;
    }
    public get params(): Readonly<Record<string, string>> {
        return this._params;
    }
    public constructor(req: ServerRequest, props: T, params: Record<string, string>) {
        this._req = req;
        this._props = props;
        this._params = params;
    }
}

export class Router<T> {
    private _routes: RouterItem<T>[] = [];
    private _add(method: RouterMethod, pattern: string, head: RouterHandler<T>, ...tail: RouterHandler<T>[]) {
        const item = new RouterItem<T>(method, pattern, head, ...tail);
        for (const i of this._routes) {
            if (item.conflicts(i)) {
                throw new Error(`pattern "${item.pattern}" conflicts with previously added pattern "${i.pattern}"`);
            }
        }
        this._routes.push(item);
    }
    public GET(pattern: string, head: RouterHandler<T>, ...tail: RouterHandler<T>[]): void {
        this._add('GET', pattern, head, ...tail);
    }
    public POST(pattern: string, head: RouterHandler<T>, ...tail: RouterHandler<T>[]): void {
        this._add('POST', pattern, head, ...tail);
    }
    public PATCH(pattern: string, head: RouterHandler<T>, ...tail: RouterHandler<T>[]): void {
        this._add('PATCH', pattern, head, ...tail);
    }
    public DELETE(pattern: string, head: RouterHandler<T>, ...tail: RouterHandler<T>[]): void {
        this._add('DELETE', pattern, head, ...tail);
    }
    public OPTIONS(pattern: string, head: RouterHandler<T>, ...tail: RouterHandler<T>[]): void {
        this._add('OPTIONS', pattern, head, ...tail);
    }
    public async process(req: ServerRequest, props: T): Promise<boolean> {
        const urlobj = new URL(req.url, 'http://whatever');
        const parts = urlobj.pathname.split('/').filter(i => !!i);

        for (const route of this._routes) {
            const res = route.matches(req.method, parts);
            if (res.matches) {
                const context = new RouterContext(req, props, res.params);
                for (const handler of route.handlers) {
                    let next = false;
                    await handler(context, () => { next = true; });
                    if (!next) {
                        break;
                    }
                }
                return true;
            }
        }
        return false;
    }
}

export const respondJSON = async (req: ServerRequest, value: object, options?: { status?: number, headers?: Record<string, string> }): Promise<void> => {
    const content = JSON.stringify(value);
    return req.respond({
        status: options?.status ?? 200,
        body: content,
        headers: new Headers([
            ['Content-Type', 'application/json'],
            ['Content-Length', content.length.toString()],
            ...Object.entries(options?.headers ?? {})
        ])
    });
}

export const respondFile = async (req: ServerRequest, path: string, options?: { status?: number, headers?: Record<string, string> }): Promise<void> => {
    if (path.includes('../') || path.includes('./')) {
        return req.respond({ status: 404 });
    } else {
        if (FS.existsSync(path)) {
            const size = Deno.statSync(path).size.toString()
            const file = Deno.openSync(path, { read: true });
            const type_ = MIMETYPE[Path.extname(path)];
            const headers = [['Content-Length', size], ...Object.entries(options?.headers ?? {})];
            if (type_ !== undefined) {
                headers.push(['Content-Type', type_]);
            }
            try {
                await req.respond({
                    status: options?.status ?? 200,
                    body: file,
                    headers: new Headers(headers)
                });
            } finally {
                file.close();
            }
        } else {
            return req.respond({ status: 404 });
        }
    }
}

export const respondCORS = async (req: ServerRequest, options: { allowOrigin: string, allowMethods: string, allowHeaders: string, allowCredentials: boolean }): Promise<void> => {
    return req.respond({
        headers: new Headers([
            ['Access-Control-Allow-Origin', options.allowOrigin],
            ['Access-Control-Allow-Methods', options.allowMethods],
            ['Access-Control-Allow-Headers', options.allowHeaders],
            ['Access-Control-Allow-Credentials', options.allowCredentials ? 'true' : 'false']
        ])
    });
}

export const respondLocation = async (req: ServerRequest, url: string, options?: { headers?: Record<string, string> }): Promise<void> => {
    return req.respond({
        status: 302,
        headers: new Headers([
            ['Location', encodeURI(url)],
            ...Object.entries(options?.headers ?? {})
        ])
    });
}

export const paramsToObject = (params: string, sep: string): Record<string, string> => {
    const ret: any = {};
    params.split(sep).forEach(pair => {
        const [ key, value ] = pair.split('=');
        ret[key] = value;
    });
    return ret;
}

export const getPath = (req: ServerRequest): string => {
    const __req: any = (req as any);
    if (__req.hasOwnProperty('__path')) {
        return (__req.__path as string);
    } else {
        if (!__req.hasOwnProperty('__url')) {
            __req.__url = new URL(req.url, 'http://whatever');
        }
        return (__req.__path = __req.__url.pathname);
    }
}

export const getSearch = (req: ServerRequest): Record<string, string> => {
    const __req: any = (req as any);
    if (__req.hasOwnProperty('__search')) {
        return (__req.__search as Record<string, string>);
    } else {
        if (!__req.hasOwnProperty('__url')) {
            __req.__url = new URL(req.url, 'http://whatever');
        }
        return (__req.__search = paramsToObject(__req.__url.search.replace('?', ''), '&'));
    }
}

export const getHash = (req: ServerRequest): Record<string, string> => {
    const __req: any = (req as any);
    if (__req.hasOwnProperty('__hash')) {
        return (__req.__hash as Record<string, string>);
    } else {
        if (!__req.hasOwnProperty('__url')) {
            __req.__url = new URL(req.url, 'http://whatever');
        }
        return (__req.__hash = paramsToObject(__req.__url.hash.replace('#', ''), '&'));
    }
}

export const getCookie = (req: ServerRequest): Record<string, string> => {
    const __req: any = (req as any);
    if (__req.hasOwnProperty('__cookie')) {
        return (__req.__cookie as Record<string, string>);
    } else {
        return (__req.__cookie = paramsToObject(req.headers.get('Cookie') ?? '', '&'));
    }
}

export const getHeaders = (req: ServerRequest): Record<string, string> => {
    const __req: any = (req as any);
    if (!__req.hasOwnProperty('__headers')) {
        __req.__headers = {};
        req.headers.forEach((value, key) => __req.__headers[key] = value);
    }
    return (__req.__headers as Record<string, string>);
}

export const readBodyAsText = async (req: ServerRequest): Promise<string> => {
    const __req: any = (req as any);
    if (!__req.hasOwnProperty('__bodytext')) {
        __req.__bodytext = (new TextDecoder()).decode(await Deno.readAll(req.body));
    }
    return (__req.__bodytext as string);
}

export const readBodyAsJSON = async (req: ServerRequest): Promise<any> => {
    const __req: any = (req as any);
    if (!__req.hasOwnProperty('__bodyjson')) {
        const text = await readBodyAsText(req);
        const type = req.headers.get('Content-Type');
        if (type === 'application/json') {
            try {
                __req.__bodyjson = JSON.parse(text);
            } catch (e) {
                throw new JSONParseError(e.message);
            }
        } else if (type === 'application/x-www-form-urlencoded') {
            __req.__bodyjson = paramsToObject(decodeURIComponent(text), '&');
        } else {
            throw new UnsupportedMediaTypeError(`content type "${type}" not supported`);
        }
    }
    return (__req.__bodyjson as any);
}

export function bodyJSON<T>(key: keyof T, onerror?: (e: any) => void): RouterHandler<T> {
    return async (context: RouterContext<T>, next: () => void): Promise<void> => {
        try {
            context.props[key] = await readBodyAsJSON(context.req);
            next();
        } catch (e) {
            if (e instanceof UnsupportedMediaTypeError) {
                context.req.respond({ status: 415 }).catch(onerror ?? (() => {}));
            } else if (e instanceof JSONParseError) {
                context.req.respond({ status: 400 }).catch(onerror ?? (() => {}));
            } else {
                context.req.respond({ status: 500 }).catch(onerror ?? (() => {}));
            }
        }
    }
}
