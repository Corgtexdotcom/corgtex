import path from "node:path";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Link",
            value: '<\\/llms.txt>; rel="llms-txt"',
          },
        ],
      },
    ];
  },
};

export default withNextIntl(config);
