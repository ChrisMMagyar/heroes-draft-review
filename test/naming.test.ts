import { describe, expect, it } from "vitest"
import { buildBaseName, extensionFor, personPart, slug, uniqueBaseName } from "../lib/intake/naming"

describe("file naming (spec 4.4)", () => {
  it("builds Person_description_date", () => {
    expect(buildBaseName({ people: ["Mike Ross"], description: "clinch drill at Heroes 280", descriptionFallback: "photo", date: "2026-10-10", hold: false, index: 0 }))
      .toBe("Mike-Ross_clinch-drill-at-Heroes-280_2026-10-10")
  })
  it("empty parts fall back to Unnamed / photo", () => {
    expect(buildBaseName({ people: [], description: "", descriptionFallback: "photo", date: "2026-10-10", hold: false, index: 0 }))
      .toBe("Unnamed_photo_2026-10-10")
    expect(buildBaseName({ people: ["!!!"], description: "???", descriptionFallback: "video", date: "2026-10-10", hold: false, index: 0 }))
      .toBe("Unnamed_video_2026-10-10")
  })
  it("unicode is folded to ASCII", () => {
    expect(slug("José Ñúñez")).toBe("Jose-Nunez")
    expect(slug("日本 dojo")).toBe("dojo")
  })
  it("groups and several people", () => {
    expect(personPart(["Group"])).toBe("Group")
    expect(personPart(["Jane Doe", "Bob", "Al"])).toBe("Jane-Doe-and-2-others")
    expect(personPart(["Jane Doe", "Bob"])).toBe("Jane-Doe-and-1-other")
  })
  it("HOLD prefix and album index", () => {
    expect(buildBaseName({ people: [], description: "", descriptionFallback: "photo", date: "2026-10-10", hold: true, index: 3 }))
      .toBe("HOLD_Unnamed_photo_2026-10-10-03")
  })
  it("extensions", () => {
    expect(extensionFor("image/jpeg", null)).toBe("jpg")
    expect(extensionFor("video/quicktime", null)).toBe("mov")
    expect(extensionFor("application/x-odd", "clip.MKV")).toBe("mkv")
  })
  it("clashes get -02, -03 (checks the sidecar name too)", async () => {
    const taken = new Set(["A_b_2026-10-10.jpg", "A_b_2026-10-10-02.json"])
    expect(await uniqueBaseName("A_b_2026-10-10", "jpg", async (n) => taken.has(n))).toBe("A_b_2026-10-10-03")
  })
})
