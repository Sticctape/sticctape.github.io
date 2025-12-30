export interface Env {
    DB: D1Database;
    IMAGES: R2Bucket;
    JWT_SECRET?: string;
    JWT_AUD?: string;
    JWT_ISS?: string;
    STAFF_API_TOKEN?: string;
    ALLOW_HEADER_DEV?: string;
}
declare const _default: {
    fetch(request: Request, env: Env): Promise<Response>;
};
export default _default;
//# sourceMappingURL=worker.d.ts.map