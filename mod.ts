import { ServerRequest } from 'https://deno.land/std/http/server.ts'
import * as Path from 'https://deno.land/std/path/mod.ts'
import * as FS from 'https://deno.land/std/fs/mod.ts'

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
}

export const paramsToObject = (params: string, sep: string): object => {
    const ret: any = {};
    params.split(sep).forEach(pair => {
        const [ key, value ] = pair.split('=');
        ret[key] = value;
    });
    return ret;
}

type RouterMethod = ('GET' | 'POST' | 'PATCH' | 'DELETE' | 'OPTIONS');
type RouterParams = { [key: string]: string };
type RouterHandler<T> = (context: RouterContext<T>, next?: () => void) => (Promise<void> | void);

class RouterContext<T> {
    private _request: ServerRequest;
    private _params: RouterParams;
    private _props: T;
    public get request(): ServerRequest {
        return this._request;
    }
    public get props(): T {
        return this._props;
    }
    public get params(): any {
        return this._params;
    }
    public get path(): string {
        const req: any = (this._request as any);
        if (req.hasOwnProperty('__path')) {
            return (req.__path as string);
        } else {
            if (!req.hasOwnProperty('__url')) {
                req.__url = new URL(this._request.url, 'http://whatever');
            }
            return (req.__path = req.__url.pathname);
        }
    }
    public get search(): object {
        const req: any = (this._request as any);
        if (req.hasOwnProperty('__search')) {
            return (req.__search as object);
        } else {
            if (!req.hasOwnProperty('__url')) {
                req.__url = new URL(this._request.url, 'http://whatever');
            }
            return (req.__search = paramsToObject(req.__url.search.replace('?', ''), '&'));
        }
    }
    public get hash(): object {
        const req: any = (this._request as any);
        if (req.hasOwnProperty('__hash')) {
            return (req.__hash as object);
        } else {
            if (!req.hasOwnProperty('__url')) {
                req.__url = new URL(this._request.url, 'http://whatever');
            }
            return (req.__hash = paramsToObject(req.__url.hash.replace('#', ''), '&'));
        }
    }
    public constructor(request: ServerRequest, props: T, params: RouterParams) {
        this._request = request;
        this._props = props;
        this._params = params;
    }
    public respondJSON(value: object): void {
        const content = JSON.stringify(value);
        this._request.respond({
            status: 200,
            body: content,
            headers: new Headers([
                ['Content-Type', 'application/json'],
                ['Content-Length', content.length.toString()]
            ])
        });
    }
    public respondFile(path: string): void {
        if (path.includes('../') || path.includes('./')) {
            this._request.respond({ status: 404 });
        } else {
            if (FS.existsSync(path)) {
                const size = Deno.statSync(path).size.toString()
                const file = Deno.openSync(path, { read: true });
                const type_ = MIMETYPE[Path.extname(path)];
                const headers = [['Content-Length', size]];
                if (type_ !== undefined) {
                    headers.push(['Content-Type', type_]);
                }
                this._request.respond({
                    status: 200,
                    body: file,
                    headers: new Headers(headers)
                });
                this._request.done.then(() => file.close());
            } else {
                this._request.respond({ status: 404 });
            }
        }
    }
    public respondCORS(options: { allowOrigin: string, allowMethods: string, allowHeaders: string, allowCredentials: boolean }): void {
        this._request.respond({
            headers: new Headers([
                ['Access-Control-Allow-Origin', options.allowOrigin],
                ['Access-Control-Allow-Methods', options.allowMethods],
                ['Access-Control-Allow-Headers', options.allowHeaders],
                ['Access-Control-Allow-Credentials', options.allowCredentials ? 'true' : 'false']
            ])
        });
    }
    public respondLocation(url: string): void {
        this._request.respond({
            status: 302,
            headers: new Headers([
                ['Location', encodeURI(url)]
            ])
        });
    }
}

class RouterItem<T> {
    private _method: RouterMethod;
    private _pattern: string;
    private _handlers: RouterHandler<T>[];
    private _parts: { name: string, param: boolean }[];
    private _variadic: boolean;
    public get method(): RouterMethod {
        return this._method;
    };
    public get pattern(): string {
        return this._pattern;
    };
    public get handlers(): RouterHandler<T>[] {
        return this._handlers;
    };
    public get parts(): { name: string, param: boolean }[] {
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
    public matches(method: string, parts: string[]): { matches: boolean, params: RouterParams } {
        if (method.toUpperCase() === this._method) {
            if (((this._parts.length === parts.length) && !this._variadic)
            || ((this._parts.length <= parts.length) && this._variadic)) {
                const params: RouterParams = {};
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

export class Router<T> {
    private _routes: RouterItem<T>[] = [];
    private _addRoute(method: RouterMethod, pattern: string, head: RouterHandler<T>, ...tail: RouterHandler<T>[]) {
        const item = new RouterItem<T>(method, pattern, head, ...tail);
        for (const i of this._routes) {
            if (item.conflicts(i)) {
                throw new Error(`pattern "${item.pattern}" conflicts with previously added pattern "${i.pattern}"`);
            }
        }
        this._routes.push(item);
    }
    public GET(pattern: string, head: RouterHandler<T>, ...tail: RouterHandler<T>[]): void {
        this._addRoute('GET', pattern, head, ...tail);
    }
    public POST(pattern: string, head: RouterHandler<T>, ...tail: RouterHandler<T>[]): void {
        this._addRoute('POST', pattern, head, ...tail);
    }
    public PATCH(pattern: string, head: RouterHandler<T>, ...tail: RouterHandler<T>[]): void {
        this._addRoute('PATCH', pattern, head, ...tail);
    }
    public DELETE(pattern: string, head: RouterHandler<T>, ...tail: RouterHandler<T>[]): void {
        this._addRoute('DELETE', pattern, head, ...tail);
    }
    public OPTIONS(pattern: string, head: RouterHandler<T>, ...tail: RouterHandler<T>[]): void {
        this._addRoute('OPTIONS', pattern, head, ...tail);
    }
    public async process(request: ServerRequest, props: T): Promise<boolean> {
        const urlobj = new URL(request.url, 'http://whatever');
        const parts = urlobj.pathname.split('/').filter(i => !!i);

        for (const route of this._routes) {
            const res = route.matches(request.method, parts);
            if (res.matches) {
                const context = new RouterContext(request, props, res.params);
                for (const handler of route.handlers) {
                    let next = false;
                    handler(context, () => { next = true; });
                    if (!next) break;
                }
                return true;
            }
        }
        return false;
    }
}