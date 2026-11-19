// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  contentHash,
  contentQueryTokens,
  crossWordQueryTokens,
  jaccard,
  literalTerms,
  queryPhrases,
  querySegments,
  queryTokens,
  scopeToken,
  tokenize,
} from "../../src/services/memory/text.js";

/** unicode61 (tokenchars '_') keeps a token whole only if it is made of letters, marks, digits and "_". */
const FTS_SAFE = /^[\p{L}\p{M}\p{N}_]+$/u;

describe("contentHash", () => {
  it("ignores case, NFKC width and whitespace differences", () => {
    expect(contentHash("  Hello\n\tWorld ")).toBe(contentHash("hello world"));
    expect(contentHash("ＡＢＣ　１２３")).toBe(contentHash("abc 123"));
    expect(contentHash("hello world")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when the words differ", () => {
    expect(contentHash("喜欢深色模式")).not.toBe(contentHash("不喜欢深色模式"));
  });
});

describe("scopeToken", () => {
  it("is an opaque, stable ASCII token per scope key", () => {
    const token = scopeToken("bot:agent-1");
    expect(token).toMatch(/^s[0-9a-f]{20}$/);
    expect(scopeToken("bot:agent-1")).toBe(token);
    expect(scopeToken("bot:agent-2")).not.toBe(token);
    expect(scopeToken("profile:")).toMatch(/^s[0-9a-f]{20}$/);
  });
});

describe("jaccard", () => {
  it("compares token sets", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard(["a", "a", "b"], ["b", "a"])).toBe(1);
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(["a"], [])).toBe(0);
  });
});

describe("tokenize", () => {
  it("keeps every Han bigram and the dictionary words that are not bigrams", () => {
    expect(tokenize("北京出差开会")).toEqual(["北京", "京出", "出差", "差开", "开会"]);
    const tokens = tokenize("协作工作室");
    expect(tokens).toEqual(expect.arrayContaining(["协作", "工作", "作室", "工作室"]));
  });

  it("keeps single-character words so a one-character query can still match", () => {
    expect(tokenize("我明天要去北京")).toEqual(expect.arrayContaining(["去", "要", "北京", "明天"]));
    expect(tokenize("猫")).toEqual(["猫"]);
  });

  it("splits camelCase and snake_case and keeps the whole identifier", () => {
    expect(tokenize("getUserById")).toEqual(["get", "user", "by", "id", "getuserbyid"]);
    expect(tokenize("snake_case_name")).toEqual(["snake", "case", "name", "snake_case_name"]);
    expect(tokenize("HTTPServer")).toEqual(["http", "server", "httpserver"]);
  });

  it("joins dotted versions, paths and dates into one token next to their parts", () => {
    expect(tokenize("v2.3.1")).toEqual(["v2", "v2_3_1"]);
    expect(tokenize("src/services/memory/retrieval.ts")).toEqual([
      "src",
      "services",
      "memory",
      "retrieval",
      "ts",
      "src_services_memory_retrieval_ts",
    ]);
    expect(tokenize("2026-11-10")).toEqual(["2026", "11", "10", "2026_11_10"]);
  });

  it("normalizes case and width and drops one-letter Latin words", () => {
    expect(tokenize("#0FB5AE")).toEqual(["0fb5ae"]);
    expect(tokenize("ＡＢＣ１２３ a I")).toEqual(["abc123"]);
  });

  it("keeps duplicates in order", () => {
    expect(tokenize("memory memory")).toEqual(["memory", "memory"]);
  });

  it("produces only tokens FTS5 keeps whole", () => {
    const text =
      "用React写的 getUserById(v2.3.1) 见 https://example.com/a?b=1 和 C:\\work\\a.ts；颜色 #0FB5AE，「引号」\n" +
      "カタカナ ひらがな 한국어 café naïve Ωμέγα 😀 50% 3.5GB";
    for (const token of tokenize(text)) expect(token).toMatch(FTS_SAFE);
  });
});

describe("queryTokens", () => {
  it("drops Chinese stop words and bigrams made only of them", () => {
    const tokens = queryTokens("什么时候去北京出差");
    expect(tokens).toEqual(expect.arrayContaining(["北京", "出差"]));
    expect(tokens).not.toContain("什么");
    expect(tokens).not.toContain("时候");
    expect(tokens).not.toContain("什么时候");
    expect(tokens).not.toContain("去");
  });

  it("drops English stop words", () => {
    expect(queryTokens("What is the getUserById function?")).toEqual(
      expect.arrayContaining(["getuserbyid", "user", "function"]),
    );
    expect(queryTokens("What is the getUserById function?")).not.toContain("the");
  });

  it("returns distinct tokens", () => {
    const tokens = queryTokens("北京 北京 北京");
    expect(tokens).toEqual(["北京"]);
  });

  it("uses single Han characters only when nothing stronger is left", () => {
    expect(queryTokens("猫")).toEqual(["猫"]);
    expect(queryTokens("猫呢")).toContain("猫");
    expect(queryTokens("北京的猫")).not.toContain("猫");
  });

  it("returns nothing for small talk", () => {
    expect(queryTokens("你好")).toEqual([]);
    expect(queryTokens("hello, thanks")).toEqual([]);
    expect(queryTokens("   ")).toEqual([]);
  });

  it("keeps 会 in the meeting words ICU splits off", () => {
    expect(contentQueryTokens("周会什么时候开")).toContain("周会");
    expect(contentQueryTokens("早会是线上还是线下")).toContain("早会");
  });

  it("does not take function characters the segmenter glued together for content", () => {
    // ICU reads 的是 as one word; it says nothing about the topic.
    const tokens = contentQueryTokens("按钮圆角定的是多少");
    expect(tokens).toEqual(expect.arrayContaining(["按钮", "圆角"]));
    for (const noise of ["定的", "的是", "是多"]) expect(tokens).not.toContain(noise);
    expect(contentQueryTokens("周末我不回消息")).not.toContain("我不");
  });

  it("marks bigrams that straddle a word boundary, so recall can tell a split word from two neighbours", () => {
    const cross = crossWordQueryTokens("按钮圆角定的是多少");
    // 圆角 is a word the segmenter split; 角定 is two neighbours. Only the documents can tell them apart.
    expect(cross.has("圆角")).toBe(true);
    expect(cross.has("角定")).toBe(true);
    expect(cross.has("按钮")).toBe(false);
    expect(crossWordQueryTokens("how many windows").size).toBe(0);
  });
});

describe("querySegments", () => {
  const texts = (query: string) => querySegments(query).map((segment) => segment.text);

  it("leaves a question whole", () => {
    expect(texts("首页主色是什么？")).toEqual(["首页主色是什么"]);
    expect(texts("团建去哪里，什么时候？")).toEqual(["团建去哪里，什么时候"]);
  });

  it("cuts a Personal Agent request at its lines", () => {
    expect(texts("整理一份雨天出行清单\n记得把雨具和换洗衣服写进去\n雨天散步怎么样")).toEqual([
      "整理一份雨天出行清单",
      "记得把雨具和换洗衣服写进去",
      "雨天散步怎么样",
    ]);
  });

  it("joins a clause too small to stand alone to the next one, or at the end to the previous one", () => {
    expect(texts("对了，周二晚上我有个固定安排，别往那天晚上塞东西，好吗？")).toEqual([
      "对了，周二晚上我有个固定安排",
      "别往那天晚上塞东西，好吗",
    ]);
    const brief = texts("帮我做一张发布海报，竖版。背景别用纯白，用我们首页定的那个主色做一个很浅的渐变，别堆元素。");
    expect(brief).toContain("用我们首页定的那个主色做一个很浅的渐变");
    expect(brief.every((segment) => contentQueryTokens(segment).length >= 3)).toBe(true);
  });

  it("keeps versions, paths and identifiers whole and reports offsets into the query", () => {
    const query = "基础镜像用 python:3.12-slim，升级到 v2.3 以后跑 make smoke ENV=staging。Then deploy it, please.";
    const segments = querySegments(query);
    expect(segments.map((segment) => segment.text)).toEqual([
      "基础镜像用 python:3.12-slim",
      "升级到 v2.3 以后跑 make smoke ENV=staging。Then deploy it, please",
    ]);
    for (const segment of segments) expect(query.slice(segment.start, segment.end)).toBe(segment.text);
  });
});

describe("queryPhrases", () => {
  it("finds runs of adjacent content words", () => {
    expect(queryPhrases("什么时候去北京出差")).toContain("北京出差");
    expect(queryPhrases("turn on the dark mode toggle")).toContain("dark mode toggle");
    expect(queryPhrases("北京")).toEqual([]);
  });
});

describe("literalTerms", () => {
  const texts = (query: string) => literalTerms(query).map((term) => term.text);

  it("takes identifiers, versions, paths and hex colours", () => {
    expect(texts("getUserById 返回 null")).toContain("getuserbyid");
    expect(texts("升级到 v2.3.1 了吗")).toContain("v2.3.1");
    expect(texts("看 src/memory/retrieval.ts")).toContain("src/memory/retrieval.ts");
    expect(texts("主色 #0FB5AE")).toContain("0fb5ae");
  });

  it("takes quoted strings, URLs and numbers with units", () => {
    expect(texts("“北京出差” 的安排")).toContain("北京出差");
    expect(texts("打开 https://example.com/docs, 然后")).toContain("https://example.com/docs");
    expect(texts("大概 500 字")).toContain("500字");
    expect(texts("延迟 15ms")).toContain("15ms");
  });

  it("ignores plain words", () => {
    expect(literalTerms("remember my favourite colour")).toEqual([]);
    expect(literalTerms("我喜欢什么颜色")).toEqual([]);
  });

  it("gives partial identifiers a prefix or part phrase", () => {
    const [hex] = literalTerms("0FB5");
    expect(hex?.phrases).toContainEqual({ tokens: ["0fb5"], prefix: true });
    const [camel] = literalTerms("UserById");
    expect(camel?.phrases).toContainEqual({ tokens: ["user", "by", "id"], prefix: false });
    const [version] = literalTerms("v2.3.1");
    expect(version?.phrases).toEqual([{ tokens: ["v2_3_1"], prefix: false }]);
  });
});
