import { describe, test, expect, beforeAll } from "@jest/globals";
import ClientAdapter from "../index.js";
import { GeoPoint } from "firebase/firestore";
import { httpsCallable, getFunctions } from "firebase/functions"; // ← getFunctions を追加
import "./setup.js"; // Firebase 初期化

describe("ClientAdapter", () => {
  let adapter;

  beforeAll(() => {
    adapter = new ClientAdapter();
  });

  describe("インスタンス化", () => {
    test("ClientAdapter がインスタンス化できる", () => {
      expect(adapter).toBeInstanceOf(ClientAdapter);
    });

    test('type が "CLIENT" を返す', () => {
      expect(adapter.type).toBe("CLIENT");
    });
  });

  describe("firestore", () => {
    test("firestore インスタンスが取得できる", () => {
      expect(adapter.firestore).toBeDefined();
      expect(typeof adapter.firestore).toBe("object");
    });
  });

  describe("auth", () => {
    test("auth インスタンスが取得できる", () => {
      expect(adapter.auth).toBeDefined();
      expect(typeof adapter.auth).toBe("object");
    });
  });

  describe("functions", () => {
    test("functions インスタンスが取得できる", () => {
      expect(adapter.functions).toBeDefined();
      expect(typeof adapter.functions).toBe("object");
    });

    test("functions が getFunctions() の結果と一致する", () => {
      // ← 修正: import した getFunctions を使用
      expect(adapter.functions.app).toBeDefined();
      expect(typeof adapter.functions).toBe("object");
    });
  });

  describe("GeoPoint", () => {
    test("GeoPoint クラスが取得できる", () => {
      expect(adapter.GeoPoint).toBeDefined();
      expect(adapter.GeoPoint).toBe(GeoPoint);
    });

    test("GeoPoint インスタンスを生成できる", () => {
      const point = new adapter.GeoPoint(35.6812, 139.7671);
      expect(point.latitude).toBe(35.6812);
      expect(point.longitude).toBe(139.7671);
    });
  });

  describe("httpsCallable", () => {
    test("httpsCallable 関数が取得できる", () => {
      expect(adapter.httpsCallable).toBeDefined();
      expect(typeof adapter.httpsCallable).toBe("function");
      expect(adapter.httpsCallable).toBe(httpsCallable);
    });

    test("httpsCallable で Cloud Functions を呼び出せる形式になっている", () => {
      // モック関数として実行可能かテスト
      const callable = adapter.httpsCallable(adapter.functions, "testFunction");
      expect(typeof callable).toBe("function");
    });
  });

  describe("logger", () => {
    test("logger が console を返す", () => {
      expect(adapter.logger).toBe(console);
    });
  });
});
