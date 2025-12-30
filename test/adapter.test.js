import { describe, test, expect, beforeAll, beforeEach } from "@jest/globals";
import ClientAdapter from "../index.js";
import { GeoPoint } from "firebase/firestore";
import { httpsCallable, getFunctions } from "firebase/functions";
import { getApp } from "firebase/app";
import "./setup.js"; // Firebase 初期化

describe("ClientAdapter", () => {
  describe("functions なしで初期化", () => {
    let adapter;

    beforeEach(() => {
      // 各テストの前に ClientAdapter をリセット
      ClientAdapter.firestore = null;
      ClientAdapter.auth = null;
      ClientAdapter.functions = null;
      ClientAdapter.GeoPoint = null;
      ClientAdapter.httpsCallable = null;

      adapter = new ClientAdapter(); // functions なし
    });

    test("ClientAdapter がインスタンス化できる", () => {
      expect(adapter).toBeInstanceOf(ClientAdapter);
    });

    test('type が "CLIENT" を返す', () => {
      expect(adapter.type).toBe("CLIENT");
    });

    test("functions が null を返す", () => {
      expect(adapter.functions).toBeNull();
    });

    test("firestore インスタンスが取得できる", () => {
      expect(adapter.firestore).toBeDefined();
      expect(typeof adapter.firestore).toBe("object");
    });

    test("auth インスタンスが取得できる", () => {
      expect(adapter.auth).toBeDefined();
      expect(typeof adapter.auth).toBe("object");
    });

    test("GeoPoint クラスが取得できる", () => {
      expect(adapter.GeoPoint).toBeDefined();
      expect(adapter.GeoPoint).toBe(GeoPoint);
    });

    test("httpsCallable 関数が取得できる", () => {
      expect(adapter.httpsCallable).toBeDefined();
      expect(typeof adapter.httpsCallable).toBe("function");
      expect(adapter.httpsCallable).toBe(httpsCallable);
    });

    test("logger が console を返す", () => {
      expect(adapter.logger).toBe(console);
    });
  });

  describe("functions ありで初期化", () => {
    let adapter;
    let mockFunctions;

    beforeEach(() => {
      // 各テストの前に ClientAdapter をリセット
      ClientAdapter.firestore = null;
      ClientAdapter.auth = null;
      ClientAdapter.functions = null;
      ClientAdapter.GeoPoint = null;
      ClientAdapter.httpsCallable = null;

      const app = getApp();
      mockFunctions = getFunctions(app, "asia-northeast1");
      adapter = new ClientAdapter(mockFunctions); // functions あり
    });

    test("ClientAdapter がインスタンス化できる", () => {
      expect(adapter).toBeInstanceOf(ClientAdapter);
    });

    test("functions インスタンスが設定される", () => {
      expect(adapter.functions).toBeDefined();
      expect(adapter.functions).toBe(mockFunctions);
      expect(typeof adapter.functions).toBe("object");
    });

    test("functions.app が定義されている", () => {
      expect(adapter.functions.app).toBeDefined();
    });

    test("httpsCallable で Cloud Functions を呼び出せる形式になっている", () => {
      const callable = adapter.httpsCallable(adapter.functions, "testFunction");
      expect(typeof callable).toBe("function");
    });

    test("GeoPoint インスタンスを生成できる", () => {
      const point = new adapter.GeoPoint(35.6812, 139.7671);
      expect(point.latitude).toBe(35.6812);
      expect(point.longitude).toBe(139.7671);
    });
  });
});
