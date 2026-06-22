/*!
powerfullz 的 Substore 订阅转换脚本
https://github.com/powerfullz/override-rules

支持的传入参数：
- loadbalance: 启用负载均衡（url-test/load-balance，默认 false）
- landing: 启用落地节点功能（如机场家宽/星链/落地分组，默认 false）
- ipv6: 启用 IPv6 支持（默认 false）
- full: 输出完整配置（适合纯内核启动，默认 false）
- keepalive: 启用 tcp-keep-alive（默认 false）
- fakeip: DNS 使用 FakeIP 模式（默认 false，false 为 RedirHost）
- quic: 允许 QUIC 流量（UDP 443，默认 false）
- threshold: 国家节点数量小于该值时不显示分组 (默认 0)
- regex: 使用正则过滤模式（include-all + filter）写入各国家代理组，而非直接枚举节点名称（默认 false）
*/

// 节点名称后缀，通过加上后缀来生成"香港节点"等国家策略组名称
const NODE_SUFFIX = "节点";

// 工具函数：将传入的值解析为布尔值 (支持字符串 "true"/"1" 或布尔类型)
function parseBool(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        return value.toLowerCase() === "true" || value === "1";
    }
    return false;
}

// 工具函数：将传入的值解析为数字，解析失败则返回默认值
function parseNumber(value, defaultValue = 0) {
    if (value === null || typeof value === "undefined") {
        return defaultValue;
    }
    const num = parseInt(value, 10);
    return isNaN(num) ? defaultValue : num;
}

/**
 * 解析传入的脚本参数，并将其转换为内部使用的功能开关（feature flags）。
 * @param {object} args - 传入的原始参数对象，如 $arguments。
 * @returns {object} - 包含所有功能开关状态的对象。
 *
 * 该函数通过一个 `spec` 对象定义了外部参数名（如 `loadbalance`）到内部变量名（如 `loadBalance`）的映射关系。
 * 它会遍历 `spec` 中的每一项，对 `args` 对象中对应的参数值调用 `parseBool` 函数进行布尔化处理，
 * 并将结果存入返回的对象中。
 */
function buildFeatureFlags(args) {
    // spec: 映射规则字典，将外部传入的字符串 key（如 loadbalance）映射为内部代码使用的变量名（如 loadBalance）
    const spec = {
        loadbalance: "loadBalance",
        landing: "landing",
        ipv6: "ipv6Enabled",
        full: "fullConfig",
        keepalive: "keepAliveEnabled",
        fakeip: "fakeIPEnabled",
        quic: "quicEnabled",
        regex: "regexFilter",
    };

    // flags: 根据 spec 提取 args 并解析出的各类功能布尔值开关集合
    const flags = Object.entries(spec).reduce((acc, [sourceKey, targetKey]) => {
        acc[targetKey] = parseBool(args[sourceKey]) || false;
        return acc;
    }, {});

    /**
     * `threshold` 是数字参数，不经过 parseBool，需单独处理。
     */
    flags.countryThreshold = parseNumber(args.threshold, 1);

    return flags;
}

const rawArgs = typeof $arguments !== "undefined" ? $arguments : {};
const {
    loadBalance,
    landing,
    ipv6Enabled,
    fullConfig,
    keepAliveEnabled,
    fakeIPEnabled,
    quicEnabled,
    regexFilter,
    countryThreshold,
} = buildFeatureFlags(rawArgs);

function getCountryGroupNames(countryInfo, minCount) {
    // filtered: 过滤掉国家下节点数量不足 minCount 阈值的保留完整国家信息列表
    const filtered = countryInfo.filter((item) => item.nodes.length >= minCount);

    /**
     * 按 `countriesMeta` 中的 `weight` 字段升序排列；
     * 未配置 `weight` 的地区排在末尾（视为 Infinity）。
     */
    filtered.sort((a, b) => {
        const wa = countriesMeta[a.country]?.weight ?? Infinity; // wa: 国家 A 的内置排序权重，用于前置优先级越小越好
        const wb = countriesMeta[b.country]?.weight ?? Infinity; // wb: 国家 B 的内置排序权重
        return wa - wb;
    });

    return filtered.map((item) => item.country + NODE_SUFFIX);
}

function stripNodeSuffix(groupNames) {
    // suffixPattern: 用于匹配在国家名称末尾包含 "节点"（NODE_SUFFIX）后缀的正则表达式
    const suffixPattern = new RegExp(`${NODE_SUFFIX}$`);
    return groupNames.map((name) => name.replace(suffixPattern, ""));
}

// 基础策略组名称定义：如果需要修改生成的策略组显示名称，请修改以下对应的值
const PROXY_GROUPS = {
    SELECT: "选择代理",
    MANUAL: "手动选择",
    FALLBACK: "故障转移",
    DIRECT: "直连",
    LANDING: "落地节点",
    LOW_COST: "低倍率节点",
};

/**
 * 接受任意数量的元素（包括嵌套数组），展平后过滤掉所有假值（false、null、undefined 等），
 * 用于以声明式风格构建代理列表，让条件项直接写 `condition && value` 即可。
 */
const buildList = (...elements) => elements.flat().filter(Boolean);

function buildBaseLists({ landing, lowCostNodes, countryGroupNames, customNodes }) {
    const lowCost = lowCostNodes.length > 0 || regexFilter;

    /**
     * "选择代理"组的顶层候选列表：故障转移 → 落地节点（可选）→ 各国家组 → 低倍率（可选）→ 手动 → 直连。
     */
    const defaultSelector = buildList(
        "DIRECT",
        PROXY_GROUPS.FALLBACK,
        "自建节点",
        landing && PROXY_GROUPS.LANDING,
        countryGroupNames,
        lowCost && PROXY_GROUPS.LOW_COST,
        PROXY_GROUPS.MANUAL
    );

    /**
     * 大多数策略组的通用候选列表：以"选择代理"为首选，再跟各国家组、低倍率、手动、直连。
     */
    const defaultProxies = buildList(
        PROXY_GROUPS.SELECT,
        PROXY_GROUPS.DIRECT,
        "自建节点",
        countryGroupNames,
        lowCost && PROXY_GROUPS.LOW_COST,
        PROXY_GROUPS.MANUAL,
    );

    /**
     * 直连优先的候选列表，用于 Bilibili 等国内服务：直连排首位，其余顺序与 defaultProxies 一致。
     */
    const defaultProxiesDirect = buildList(
        PROXY_GROUPS.DIRECT,
        "自建节点",
        countryGroupNames,
        lowCost && PROXY_GROUPS.LOW_COST,
        PROXY_GROUPS.SELECT,
        PROXY_GROUPS.MANUAL
    );

    /**
     * "故障转移"组的候选列表：落地节点（可选）→ 各国家组 → 低倍率（可选）→ 手动 → 直连。
     * 不包含"选择代理"自身，避免循环引用。
     */
    const defaultFallback = buildList(
        "自建节点",
        landing && PROXY_GROUPS.LANDING,
        countryGroupNames,
        lowCost && PROXY_GROUPS.LOW_COST,
        PROXY_GROUPS.MANUAL,
        "DIRECT"
    );

    return { defaultProxies, defaultProxiesDirect, defaultSelector, defaultFallback };
}

// Rule Providers 远程规则集配置：用于定义各类第三方分流规则集
// 格式说明：包含了行为类型（behavior）、更新间隔（interval）、远程规则直链（url）以及缓存路径（path）
// 您可以在此处添加或修改自定义的 URL 规则集
const ruleProviders = {
    Download: {
        type: "http",
        behavior: "domain",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/ruleset/Download.list",
        path: "./ruleset/Download.list",
    },
    ADBlock: {
        type: "http",
        behavior: "domain",
        format: "mrs",
        interval: 86400,
        url: "https://adrules.top/adrules-mihomo.mrs",
        path: "./ruleset/ADBlock.mrs",
    },
    SogouInput: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://ruleset.skk.moe/Clash/non_ip/sogouinput.txt",
        path: "./ruleset/SogouInput.txt",
    },
    StaticResources: {
        type: "http",
        behavior: "domain",
        format: "text",
        interval: 86400,
        url: "https://ruleset.skk.moe/Clash/domainset/cdn.txt",
        path: "./ruleset/StaticResources.txt",
    },
    CDNResources: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://ruleset.skk.moe/Clash/non_ip/cdn.txt",
        path: "./ruleset/CDNResources.txt",
    },
    TikTok: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/TikTok.list",
        path: "./ruleset/TikTok.list",
    },
    Bilimanga: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/ruleset/Bilimanga.list",
        path: "./ruleset/Bilimanga.list",
    },
    PIXIV: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/ruleset/PIXIV.list",
        path: "./ruleset/PIXIV.list",
    },
    EHentai: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/ruleset/EHentai.list",
        path: "./ruleset/EHentai.list",
    },
    SteamFix: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/ruleset/SteamFix.list",
        path: "./ruleset/SteamFix.list",
    },
    GoogleFCM: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/FirebaseCloudMessaging.list",
        path: "./ruleset/FirebaseCloudMessaging.list",
    },
    AdditionalFilter: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/AdditionalFilter.list",
        path: "./ruleset/AdditionalFilter.list",
    },
    AdditionalCDNResources: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/AdditionalCDNResources.list",
        path: "./ruleset/AdditionalCDNResources.list",
    },
    Crypto: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/ruleset/Crypto.list",
        path: "./ruleset/Crypto.list",
    },
    ChinaSNS: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/ruleset/ChinaSNS.list",
        path: "./ruleset/ChinaSNS.list",
    },
    PT: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/ruleset/PT.list",
        path: "./ruleset/PT.list",
    },
    Twitter: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/ruleset/Twitter.list",
        path: "./ruleset/Twitter.list",
    },
    JanpanWeb: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/ruleset/JanpanWeb.list",
        path: "./ruleset/JanpanWeb.list",
    },
    IP: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://raw.githubusercontent.com/Volundio/override-rules/refs/heads/main/ruleset/IP.list",
        path: "./ruleset/IP.list",
    },
    MangaSite: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/ruleset/MangaSite.list",
        path: "./ruleset/MangaSite.list",
    },
    HK: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/ruleset/HK.list",
        path: "./ruleset/HK.list",
    },
    Proxy: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://raw.githubusercontent.com/Volundio/override-rules/refs/heads/main/ruleset/Proxy.list",
        path: "./ruleset/Proxy.list",
    },
    USA: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/ruleset/USA.list",
        path: "./ruleset/USA.list",
    },
    REJECT: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/ruleset/REJECT.list",
        path: "./ruleset/REJECT.list",
    },
    DIRECT: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://raw.githubusercontent.com/Volundio/override-rules/refs/heads/main/ruleset/DIRECT.list",
        path: "./ruleset/DIRECT.list",
    },
};

// 基础路由分流规则列表：规则按从上到下的顺序进行匹配
// 如果您需要增加自定义域名、网址关键字或 IP 的强制分流规则，请在数组开头或适当位置插入
const baseRules = [
    `RULE-SET,DIRECT,${PROXY_GROUPS.DIRECT}`,    
    `RULE-SET,PT,${PROXY_GROUPS.DIRECT}`,
    `RULE-SET,JanpanWeb,日本节点`,
    "GEOSITE,CATEGORY-AI-!CN,AI",
    `RULE-SET,REJECT,REJECT`,
    `RULE-SET,HK,香港节点`,
    `RULE-SET,USA,美国节点`,
    `RULE-SET,Proxy,${PROXY_GROUPS.SELECT}`,
    `RULE-SET,MangaSite,MangaSite`,
    `RULE-SET,Download,下载专用`,
    `RULE-SET,IP,自建节点`,
    `RULE-SET,ChinaSNS,ChinaSNS`,
    `RULE-SET,Twitter,Twitter`,
    `RULE-SET,Bilimanga,Bilimanga`,
    `RULE-SET,PIXIV,PIXIV`,
    `RULE-SET,EHentai,EHentai`,
    `RULE-SET,SteamFix,Steam`,
    `RULE-SET,ADBlock,广告拦截`,
    `RULE-SET,AdditionalFilter,广告拦截`,
    `RULE-SET,SogouInput,搜狗输入法`,
    `DOMAIN-SUFFIX,truthsocial.com,Truth Social`,
    `RULE-SET,StaticResources,静态资源`,
    `RULE-SET,CDNResources,静态资源`,
    `RULE-SET,AdditionalCDNResources,静态资源`,
    `RULE-SET,Crypto,Crypto`,
    `RULE-SET,TikTok,TikTok`,
    `RULE-SET,GoogleFCM,${PROXY_GROUPS.DIRECT}`,
    `DOMAIN,services.googleapis.cn,${PROXY_GROUPS.SELECT}`,
    `GEOSITE,GOOGLE-PLAY@CN,${PROXY_GROUPS.DIRECT}`,
    `GEOSITE,MICROSOFT@CN,${PROXY_GROUPS.DIRECT}`,
    "GEOSITE,ONEDRIVE,OneDrive",
    "GEOSITE,MICROSOFT,Microsoft",
    "GEOSITE,TELEGRAM,Telegram",
    "GEOSITE,YOUTUBE,YouTube",
    "GEOSITE,GOOGLE,Google",
    "GEOSITE,NETFLIX,Netflix",
    "GEOSITE,SPOTIFY,Spotify",
    "GEOSITE,BAHAMUT,Bahamut",
    "GEOSITE,BILIBILI,Bilibili",
    "GEOSITE,PIKPAK,PikPak",
    `GEOSITE,GFW,${PROXY_GROUPS.SELECT}`,
    `GEOSITE,CN,${PROXY_GROUPS.DIRECT}`,
    `GEOSITE,PRIVATE,${PROXY_GROUPS.DIRECT}`,
    "GEOIP,NETFLIX,Netflix,no-resolve",
    "GEOIP,TELEGRAM,Telegram,no-resolve",
    `GEOIP,CN,${PROXY_GROUPS.DIRECT}`,
    `GEOIP,PRIVATE,${PROXY_GROUPS.DIRECT}`,
    "DST-PORT,22,SSH(22端口)",
    "GEOIP,cloudflare,Cloudflare",
    `MATCH,${PROXY_GROUPS.SELECT}`,
];

// 构建最终应用的规则列表，会根据 quicEnabled 参数决定是否开启 QUIC（UDP 443）阻断
function buildRules({ quicEnabled }) {
    const ruleList = [...baseRules]; // ruleList: 基于 baseRules 浅拷贝出来的分流列表，避免对全局数组变量造成污染
    if (!quicEnabled) {
        /**
         * 屏蔽 UDP 443（QUIC）流量。
         * 部分网络环境下 UDP 性能不稳定，禁用 QUIC 可强制回退到 TCP，改善整体体验。
         */
        ruleList.unshift("AND,((DST-PORT,443),(NETWORK,UDP)),REJECT");
    }
    return ruleList;
}

// Sniffer 流量嗅探配置：用于在代理或者全局拦截时从流量中嗅探真实域名，有助于解决 DNS 污染和部分应用强制 IP 连接等问题
const snifferConfig = {
    sniff: {
        TLS: {
            ports: [443, 8443],
        },
        HTTP: {
            ports: [80, 8080, 8880],
        },
        QUIC: {
            ports: [443, 8443],
        },
    },
    "override-destination": false,
    enable: true,
    "force-dns-mapping": true,
    "skip-domain": ["Mijia Cloud", "dlg.io.mi.com", "+.push.apple.com"],
};

// 构建不同环境下的 DNS 配置（通常搭配 Redir-Host 或 Fake-IP 模式使用）
function buildDnsConfig({ mode, fakeIpFilter }) {
    const config = {
        enable: true,
        ipv6: ipv6Enabled,
        "prefer-h3": true,
        "enhanced-mode": mode,
        "default-nameserver": ["119.29.29.29", "223.5.5.5"],
        nameserver: ["system", "223.5.5.5", "119.29.29.29", "180.184.1.1"],
        fallback: [
            "quic://dns0.eu",
            "https://dns.cloudflare.com/dns-query",
            "https://dns.sb/dns-query",
            "tcp://208.67.222.222",
            "tcp://8.26.56.2",
        ],
        "proxy-server-nameserver": ["https://dns.alidns.com/dns-query", "tls://dot.pub"],
    };

    if (fakeIpFilter) {
        config["fake-ip-filter"] = fakeIpFilter;
    }

    return config;
}

// 默认 Redir-Host 模式配置
const dnsConfig = buildDnsConfig({ mode: "redir-host" });
// 默认 Fake-IP 模式配置，内置 fakeIpFilter 用于让需要直连或不能用 Fake-IP 的特定域名跳过处理
const dnsConfigFakeIp = buildDnsConfig({
    mode: "fake-ip",
    fakeIpFilter: [
        "geosite:private",
        "geosite:connectivity-check",
        "geosite:cn",
        "Mijia Cloud",
        "dig.io.mi.com",
        "localhost.ptlogin2.qq.com",
        "*.icloud.com",
        "*.stun.*.*",
        "*.stun.*.*.*",
    ],
});

// 基础 Geo 数据库下载地址，更换这些 URL 可以自定义加速源
const geoxURL = {
    geoip: "https://gcore.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geoip.dat",
    geosite: "https://gcore.jsdelivr.net/gh/Loyalsoldier/v2ray-rules-dat@release/geosite.dat",
    mmdb: "https://gcore.jsdelivr.net/gh/Loyalsoldier/geoip@release/Country.mmdb",
    asn: "https://gcore.jsdelivr.net/gh/Loyalsoldier/geoip@release/GeoLite2-ASN.mmdb",
};

/**
 * 各地区的元数据：`weight` 决定在代理组列表中的排列顺序（值越小越靠前，未设置则排末尾）；
 * `pattern` 是用于匹配节点名称的正则字符串；`icon` 为策略组图标 URL。
 */
const countriesMeta = {
    Others: {
        weight: 50,
        pattern: "加拿大|Canada|🇨🇦|英国|United Kingdom|UK|伦敦|GB|London|🇬🇧|澳洲|澳大利亚|AU|Australia|🇦🇺|法国|法|FR|France|🇫🇷|俄罗斯|俄|RU|Russia|🇷🇺|泰国|泰|TH|Thailand|🇹🇭|印度|IN|India|🇮🇳|马来西亚|马来|MY|Malaysia|🇲🇾|土耳其|土|TR|Turkey|🇹🇷|荷兰|NL|Netherlands|🇳🇱|阿根廷|AR|Argentina|🇦🇷|巴西|BR|Brazil|🇧🇷|乌克兰|UA|Ukraine|🇺🇦|奥地利|AT|Austria|🇦🇹|哈萨克斯坦|KZ|Kazakhstan|🇰🇿|巴基斯坦|PK|Pakistan|🇵🇰|新西兰|NZ|New Zealand|🇳🇿|斐济|FI|Fiji|🇫🇯|澳门|Macau|🇲🇴",
        icon: "https://gcore.jsdelivr.net/gh/shindgewongxj/WHATSINStash@master/icon/select.png",
    },
    台湾: {
        weight: 20,
        pattern: "台|新北|彰化|TW|Taiwan|🇹🇼|广台|台湾",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Taiwan.png",
    },
    香港: {
        weight: 10,
        pattern: "香港|港|HK|hk|Hong Kong|HongKong|hongkong|🇭🇰|广港",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Hong_Kong.png",
    },
    新加坡: {
        weight: 30,
        pattern: "新加坡|坡|狮城|SG|Singapore|🇸🇬|广新",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Singapore.png",
    },
    日本: {
        weight: 40,
        pattern: "日本|川日|东京|大阪|泉日|埼玉|沪日|深日|JP|Japan|🇯🇵|广日",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Japan.png",
    },
    韩国: {
        pattern: "KR|Korea|KOR|首尔|韩|韓|🇰🇷",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Korea.png",
    },
    美国: {
        weight: 50,
        pattern: "美国|美|US|United States|🇺🇸|堪萨斯",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/United_States.png",
    },
    德国: {
        weight: 70,
        pattern: "德国|德|DE|Germany|🇩🇪",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Germany.png",
    },
};

// 节点名称匹配正则：用于识别订阅中的"低倍率"和"落地（家宽）"节点。
// 如果您机场的节点名称不含以下关键字，请相应修改此处的正则表达式规则提取适配的内容
const LOW_COST_REGEX = /0\.[0-5]|低倍率|省流|大流量|实验性/i;
const LANDING_REGEX = /家宽|家庭|家庭宽带|商宽|商业宽带|星链|Starlink|落地/i;
const SUBSCRIPTION_INFO_REGEX = /套餐到期/i;
/**
 * `LANDING_PATTERN` 与 `LANDING_REGEX` 描述同一规则，但格式不同：
 * - `LANDING_REGEX`：JS `RegExp` 对象，供脚本内部过滤节点时使用（用 `/i` flag 表示不区分大小写）。
 * - `LANDING_PATTERN`：字符串，写入 YAML 的 `filter` / `exclude-filter` 字段，
 *   其中 `(?i)` 前缀是 Clash/Mihomo 的不区分大小写语法。
 */
const LANDING_PATTERN = "(?i)家宽|家庭|家庭宽带|商宽|商业宽带|星链|Starlink|落地";

const CUSTOM_REGEX = /自建|自建节点/i;
const CUSTOM_PATTERN = "(?i)自建|自建节点";

// 过滤机场订阅中用于展示套餐状态、到期时间等信息的伪节点
function filterSubscriptionInfoNodes(config) {
    return (config.proxies || []).filter((proxy) => !SUBSCRIPTION_INFO_REGEX.test(proxy.name || ""));
}

// 提取满足"低倍率"命名特征的所有节点名称列表
function parseLowCost(config) {
    return (config.proxies || [])
        .filter((proxy) => LOW_COST_REGEX.test(proxy.name))
        .map((proxy) => proxy.name);
}

// 提取满足"落地（家宽等特种网络）"命名特征的所有节点名称列表
function parseLandingNodes(config) {
    return (config.proxies || [])
        .filter((proxy) => LANDING_REGEX.test(proxy.name))
        .map((proxy) => proxy.name);
}

// 提取满足"自建"命名特征的所有节点名称列表
function parseCustomNodes(config) {
    return (config.proxies || [])
        .filter((proxy) => CUSTOM_REGEX.test(proxy.name))
        .map((proxy) => proxy.name);
}

/**
 * 遍历订阅中的所有节点，按 `countriesMeta` 中定义的地区进行归类。
 *
 * 归类规则：
 * - 开启落地节点功能时，名称匹配 `LANDING_REGEX` 的落地节点不参与普通地区统计。
 * - 名称匹配 `LOW_COST_REGEX` 的低倍率节点不参与统计。
 * - 每个节点只归入第一个匹配到的地区，避免重复计入。
 * - 未匹配到任何地区的节点归入 `Others` 兜底组。
 * - 地区正则来自 `countriesMeta[country].pattern`；若旧配置中 pattern 携带 `(?i)` 前缀，
 *   会在编译前自动剥离（JS RegExp 不支持该语法）。
 *
 * @param {object} config - 订阅配置对象，包含 `proxies` 数组。
 * @param {object} [options] - 解析选项。
 * @param {boolean} [options.excludeLanding=false] - 是否从普通地区组排除落地节点。
 * @returns {{ country: string, nodes: string[] }[]} - 每个元素对应一个地区及其节点名称列表。
 */
function parseCountries(config, options = {}) {
    const { excludeLanding = false } = options;
    const proxies = config.proxies || []; // proxies: 配置对象中所有未解析归类的原始代理节点集

    const countryNodes = Object.create(null); // countryNodes: 用于储存按国家分类后归类节点的中间字典对象

    // compiledRegex: 生成剥离掉部分内核格式特定要求（(?i) 等不兼容正则语法的特殊修饰符）的国家解析正则对应字典
    const compiledRegex = {};
    for (const [country, meta] of Object.entries(countriesMeta)) {
        compiledRegex[country] = new RegExp(meta.pattern.replace(/^\(\?i\)/, ""));
    }

    for (const proxy of proxies) {
        const name = proxy.name || "";

        if (excludeLanding && LANDING_REGEX.test(name)) continue;
        if (LOW_COST_REGEX.test(name)) continue;

        let matched = false;
        for (const [country, regex] of Object.entries(compiledRegex)) {
            if (regex.test(name)) {
                if (!countryNodes[country]) countryNodes[country] = [];
                countryNodes[country].push(name);
                matched = true;
                break;
            }
        }

        if (!matched) {
            if (!countryNodes.Others) countryNodes.Others = [];
            countryNodes.Others.push(name);
        }
    }

    const result = []; // result: 承接 countryNodes 内容转换为数组并输出的最终可用数组结果集
    for (const [country, nodes] of Object.entries(countryNodes)) {
        result.push({ country, nodes });
    }

    return result;
}

// 构建国家/地区级别的测速策略组（会根据 loadBalance 参数生成 url-test 或 load-balance 类型）
function buildCountryProxyGroups({ countries, landing, loadBalance, regexFilter, countryInfo }) {
    const groups = []; // groups: 最终会被组装打包返回的策略组列表配置集合
    const baseExcludeFilter = "0\\.[0-5]|低倍率|省流|大流量|实验性"; // baseExcludeFilter: 低倍率节点正则字符串（直接用于写入配置文件）
    const landingExcludeFilter = LANDING_PATTERN; // landingExcludeFilter: 落地节点正则字符串（直接用于写入配置文件）
    const groupType = loadBalance ? "load-balance" : "url-test"; // groupType: 根据开关生成国家测速配置的类型值

    /**
     * 枚举模式（`regexFilter=false`）下预先建立"地区 → 节点名列表"的索引，
     * 避免在循环内反复遍历 `countryInfo`。
     * regex 模式不需要此索引，置为 null 节省开销。
     */
    const nodesByCountry = !regexFilter
        ? Object.fromEntries(countryInfo.map((item) => [item.country, item.nodes]))
        : null; // nodesByCountry: 国家映射节点名的快速查找字典表

    for (const country of countries) {
        const meta = countriesMeta[country]; // meta: 当前所遍历到的国家的内置基础信息数据（正则/图标/权重）
        if (!meta) continue;

        let groupConfig; // groupConfig: 当前国家将被生成的独立策略组字典配置块

        if (!regexFilter) {
            /**
             * 枚举模式：直接列出已归类到该地区的节点名称，无需运行时正则过滤。
             */
            const nodeNames = nodesByCountry[country] || [];
            groupConfig = {
                name: `${country}${NODE_SUFFIX}`,
                icon: meta.icon,
                type: "select",
                proxies: nodeNames,
            };
        } else {
            /**
             * regex 模式：通过 `include-all` + `filter` 让内核在运行时动态筛选节点，
             * 同时用 `exclude-filter` 排除低倍率节点；若启用了落地功能，
             * 还需一并排除落地节点，防止其混入普通地区组。
             */
            const excludeFilterParts = buildList(
                landing && landingExcludeFilter,
                baseExcludeFilter,
                country === "Others" &&
                    Object.entries(countriesMeta)
                        .filter(([name]) => name !== "Others")
                        .map(([, countryMeta]) => countryMeta.pattern)
                        .join("|")
            );
            groupConfig = {
                name: `${country}${NODE_SUFFIX}`,
                icon: meta.icon,
                "include-all": true,
                ...(country === "Others" ? {} : { filter: meta.pattern }),
                "exclude-filter": excludeFilterParts.join("|"),
                type: "select",
            };
        }

        if (!loadBalance) {
            Object.assign(groupConfig, {
                url: "http://www.gstatic.com/generate_204",
                interval: 3666,
                tolerance: 20,
                lazy: true,
            });
        }

        groups.push(groupConfig);
    }

    return groups;
}

function buildProxyGroups({
    landing,
    countries,
    countryProxyGroups,
    lowCostNodes,
    landingNodes,
    customNodes,
    defaultProxies,
    defaultProxiesDirect,
    defaultSelector,
    defaultFallback,
}) {
    /**
     * 预先判断是否存在特定地区的节点，用于为 Bilibili、Bahamut、Truth Social 等
     * 有地区偏好的策略组提供更精准的候选列表。
     */
    const hasTW = countries.includes("台湾");
    const hasHK = countries.includes("香港");
    const hasUS = countries.includes("美国");
    const hasJP = countries.includes("日本");

    /**
     * "前置代理"组的候选列表：从 `defaultSelector` 中移除"落地节点"和"故障转移"，
     * 避免前置代理与落地节点形成循环引用，以及与故障转移组相互嵌套。
     * 仅在 `landing=true` 时使用；否则置为空数组。
     */
    const frontProxySelector = landing
        ? defaultSelector.filter(
            (name) => name !== PROXY_GROUPS.LANDING && name !== PROXY_GROUPS.FALLBACK
        )
        : [];

    return [
        {
            name: PROXY_GROUPS.SELECT,
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Proxy.png",
            type: "select",
            proxies: defaultSelector,
        },
        {
            name: PROXY_GROUPS.MANUAL,
            icon: "https://gcore.jsdelivr.net/gh/shindgewongxj/WHATSINStash@master/icon/select.png",
            "include-all": true,
            type: "select",
        },
        ...countryProxyGroups,
        landing
            ? {
                name: "前置代理",
                icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Area.png",
                type: "select",
                /**
                 * regex 模式：`include-all` 拉取所有节点，`exclude-filter` 排除落地节点，
                 * 同时在 `proxies` 里附加手动指定的候选组名列表（各国家组等）。
                 * 枚举模式：直接列出候选组名（落地节点已在构建 `frontProxySelector` 时过滤）。
                 */
                ...(regexFilter
                    ? {
                        "include-all": true,
                        "exclude-filter": LANDING_PATTERN,
                        proxies: frontProxySelector,
                    }
                    : { proxies: frontProxySelector }),
            }
            : null,
        landing
            ? {
                name: PROXY_GROUPS.LANDING,
                icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Airport.png",
                type: "select",
                /**
                 * regex 模式：`include-all` + `filter` 动态筛选落地节点。
                 * 枚举模式：直接列出已识别的落地节点名称。
                 */
                ...(regexFilter
                    ? { "include-all": true, filter: LANDING_PATTERN }
                    : { proxies: landingNodes }),
            }
            : null,
        {
            name: PROXY_GROUPS.FALLBACK,
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Bypass.png",
            type: "fallback",
            url: "https://cp.cloudflare.com/generate_204",
            proxies: defaultFallback,
            interval: 3666,
            tolerance: 20,
            lazy: true,
        },
        {
            name: "自建节点",
            icon: "https://gcore.jsdelivr.net/gh/shindgewongxj/WHATSINStash@master/icon/select.png",
            type: "select",
            ...(regexFilter
                ? { "include-all": true, filter: CUSTOM_PATTERN, proxies: ["DIRECT"] }
                : { proxies: customNodes && customNodes.length > 0 ? customNodes : ["DIRECT"] }),
        },
        {
            name: "ChinaSNS",
            icon: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/icons/SNS.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "Bilimanga",
            icon: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/icons/bilimanga.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "Bilibili",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/bilibili.png",
            type: "select",
            proxies: defaultProxies
        },
        {
            name: "PIXIV",
            icon: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/icons/pixiv.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "EHentai",
            icon: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/icons/Ehentai.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "Steam",
            icon: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/icons/steam.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "Twitter",
            icon: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/icons/x.png",
            type: "select",
            proxies: defaultProxies,
        },

        {
            name: "AI",
            icon: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/icons/chatgpt.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "MangaSite",
            icon: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/icons/comic.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "YouTube",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/YouTube.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "Telegram",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Telegram.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "Cloudflare",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Cloudflare.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "Bahamut",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Bahamut.png",
            type: "select",
            proxies: hasTW
                ? ["台湾节点", PROXY_GROUPS.SELECT, PROXY_GROUPS.MANUAL, PROXY_GROUPS.DIRECT]
                : defaultProxies,
        },
        {
            name: "下载专用",
            icon: "https://gcore.jsdelivr.net/gh/Volundio/override-rules@master/icons/download.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "Google",
            icon: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/icons/Google.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "Microsoft",
            icon: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/icons/Microsoft_Copilot.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "OneDrive",
            icon: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/icons/Onedrive.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "PikPak",
            icon: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/icons/PikPak.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "SSH(22端口)",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Server.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "静态资源",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Cloudflare.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "Crypto",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Cryptocurrency_3.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "Netflix",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Netflix.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "TikTok",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/TikTok.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "Spotify",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Spotify.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "Truth Social",
            icon: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/icons/TruthSocial.png",
            type: "select",
            proxies: hasUS
                ? ["美国节点", PROXY_GROUPS.SELECT, PROXY_GROUPS.MANUAL]
                : defaultProxies,
        },
        {
            name: "搜狗输入法",
            icon: "https://gcore.jsdelivr.net/gh/powerfullz/override-rules@master/icons/Sougou.png",
            type: "select",
            proxies: [PROXY_GROUPS.DIRECT, "REJECT"],
        },
        {
            name: PROXY_GROUPS.DIRECT,
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Direct.png",
            type: "select",
            proxies: ["DIRECT", PROXY_GROUPS.SELECT],
        },
        {
            name: "广告拦截",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/AdBlack.png",
            type: "select",
            proxies: ["REJECT", "REJECT-DROP", PROXY_GROUPS.DIRECT],
        },
        lowCostNodes.length > 0 || regexFilter
            ? {
                name: PROXY_GROUPS.LOW_COST,
                icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Lab.png",
                type: "url-test",
                url: "https://cp.cloudflare.com/generate_204",
                interval: 3666,
                tolerance: 20,
                lazy: true,
                ...(!regexFilter
                    ? { proxies: lowCostNodes }
                    : { "include-all": true, filter: "(?i)0\\.[0-5]|低倍率|省流|大流量|实验性" }),
            }
            : null,

    ].filter(Boolean);
}

// eslint-disable-next-line no-unused-vars -- 通过 vm.runInContext 在 yaml_generator 中被调用
// 主入口函数 `main`：它将接收并处理原始的订阅配置对象（config）
// 您可以在此处增加或调整最终配置内容的组装逻辑（如调整 proxyGroups, rules 等）
function main(config) {
    const resultConfig = { proxies: filterSubscriptionInfoNodes(config) };

    /**
     * 解析订阅中的节点，分别得到：地区归类信息、低倍率节点名列表、落地节点名列表，
     * 以及经过阈值过滤和权重排序后的国家组名列表与地区名列表。
     */
    const countryInfo = parseCountries(resultConfig, { excludeLanding: landing });
    const lowCostNodes = parseLowCost(resultConfig);
    const landingNodes = landing ? parseLandingNodes(resultConfig) : [];
    const customNodes = parseCustomNodes(resultConfig);
    const countryGroupNames = getCountryGroupNames(countryInfo, countryThreshold);
    const countries = stripNodeSuffix(countryGroupNames);

    /**
     * 构建各类通用候选列表，供后续策略组复用。
     */
    const { defaultProxies, defaultProxiesDirect, defaultSelector, defaultFallback } =
        buildBaseLists({ landing, lowCostNodes, countryGroupNames, customNodes });

    /**
     * 为每个地区生成对应的 `url-test` 或 `load-balance` 自动测速组。
     */
    const countryProxyGroups = buildCountryProxyGroups({
        countries,
        landing,
        loadBalance,
        regexFilter,
        countryInfo,
    });

    /**
     * 组装所有策略组（功能组 + 地区组）。
     */
    const proxyGroups = buildProxyGroups({
        landing,
        countries,
        countryProxyGroups,
        lowCostNodes,
        landingNodes,
        customNodes,
        defaultProxies,
        defaultProxiesDirect,
        defaultSelector,
        defaultFallback,
    });

    /**
     * GLOBAL 组需要枚举所有已生成的策略组名称，因此在其他组构建完成后追加，
     * 同时保留 `include-all` 以确保与各内核的兼容性。
     */
    const globalProxies = proxyGroups.map((item) => item.name);
    proxyGroups.push({
        name: "GLOBAL",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Global.png",
        "include-all": true,
        type: "select",
        proxies: globalProxies,
    });

    const finalRules = buildRules({ quicEnabled }); // finalRules: 生成和组装完毕的规则路由列表

    // 如果启用 fullConfig (完整配置输出，常用于非接管等纯内核独立运行场景)，
    // 追加诸如端口监听、日志级别、控制器地址等基础环境设置。您可以根据需要在这里修改默认端口。
    if (fullConfig)
        Object.assign(resultConfig, {
            "mixed-port": 7890,
            "redir-port": 7892,
            "tproxy-port": 7893,
            "routing-mark": 7894,
            "allow-lan": true,
            "bind-address": "*",
            ipv6: ipv6Enabled,
            mode: "rule",
            "unified-delay": true,
            "tcp-concurrent": true,
            "find-process-mode": "off",
            "log-level": "info",
            "geodata-loader": "standard",
            "external-controller": ":9999",
            "disable-keep-alive": !keepAliveEnabled,
            profile: {
                "store-selected": true,
            },
        });

    Object.assign(resultConfig, {
        "proxy-groups": proxyGroups,
        "rule-providers": ruleProviders,
        rules: finalRules,
        sniffer: snifferConfig,
        // dns: fakeIPEnabled ? dnsConfigFakeIp : dnsConfig,
        "geodata-mode": true,
        "geox-url": geoxURL,
    });

    return resultConfig;
}
