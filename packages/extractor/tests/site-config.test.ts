import { describe, expect, it } from "vitest";

import { ConfigBuilder, parseSiteConfig } from "../src";

describe("Extractor site config compatibility", () => {
  it("parses repeated, boolean, header, replacement, conditional, and wrapping directives", () => {
    const config = parseSiteConfig(`
      # an Extractor-compatible site config
      title: //h1
      body: //article
      body: //section[@class='appendix']
      strip_attr: //img/@srcset
      autodetect_on_failure: no
      http_header(X-Reader): wallaby
      replace_string(<amp-img): <img
      single_page_link: //a[@rel='canonical']
      if_page_contains: //main
      wrap_in(div): //div[@class='chapter']
    `);

    expect(config.title).toEqual(["//h1"]);
    expect(config.body).toHaveLength(2);
    expect(config.strip).toEqual(["//img/@srcset"]);
    expect(config.autodetectOnFailure()).toBe(false);
    expect(config.http_header).toEqual({ "x-reader": "wallaby" });
    expect(config.find_string).toEqual(["<amp-img"]);
    expect(config.replace_string).toEqual(["<img"]);
    expect(config.if_page_contains.single_page_link["//a[@rel='canonical']"]).toBe("//main");
    expect(config.wrap_in.div).toBe("//div[@class='chapter']");
  });

  it("uses exact host before one-level wildcard and appends global fallbacks", () => {
    const builder = new ConfigBuilder({
      "news.example.com.txt": "title: //h1[@class='exact']\nhttp_header(Accept-Language): fr",
      ".example.com.txt": "title: //h1[@class='wildcard']",
      "global.txt": "body: //article\ntitle: //title\nhttp_header(Accept): text/html",
    });

    const exact = builder.buildForHost("www.news.example.com");
    expect(exact.title).toEqual(["//h1[@class='exact']", "//title"]);
    expect(exact.body).toEqual(["//article"]);
    expect(exact.http_header).toEqual({ accept: "text/html", "accept-language": "fr" });

    const wildcard = builder.buildForHost("blog.example.com");
    expect(wildcard.title[0]).toBe("//h1[@class='wildcard']");
  });
});
