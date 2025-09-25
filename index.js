/**
 * アプリ側で使用する FireModel のアダプターです。
 * FireModel に Firestore に対する CRUD 機能を注入します。
 */
import {
  collection,
  doc,
  getDoc,
  runTransaction,
  query,
  getDocs,
  where,
  orderBy,
  limit,
  collectionGroup,
  onSnapshot,
  getFirestore,
  increment as FieldValue_increment,
} from "firebase/firestore";
import { getAuth } from "firebase/auth";

class ClientAdapter {
  static firestore = null;
  static auth = null;

  constructor() {
    ClientAdapter.firestore = getFirestore();
    ClientAdapter.auth = getAuth();
  }

  get type() {
    return "CLIENT";
  }

  /**
   * console を返します。
   * FireModel でコンソールを出力するために使用します。
   */
  get logger() {
    return console;
  }

  /**
   * Firestore インスタンスを返します。
   * - 2025-07-11 added
   */
  get firestore() {
    if (!ClientAdapter.firestore) {
      throw new Error(
        "Firestore is not initialized. Call ClientAdapter.init() first."
      );
    }
    return ClientAdapter.firestore;
  }

  /**
   * Assigns an autonumber to the instance using a Firestore transaction.
   * - Retrieves the current autonumber doc from the `Autonumbers` collection.
   * - Increments the number and sets it on the instance.
   * - Returns a function to update the `current` value in Firestore.
   * - `prefix` is used to resolve the collection path if provided.
   *
   * Firestore のトランザクションを使用して、インスタンスに採番を行います。
   * - `Autonumbers` コレクションから現在の採番情報を取得します。
   * - 採番値をインクリメントし、インスタンスに設定します。
   * - `current` 値を更新する関数を返します（呼び出し元で実行）。
   * - `prefix` が指定されている場合は、コレクションパスの解決に使用されます。
   *
   * @param {Object} args - Autonumber options.
   * @param {Object} args.transaction - Firestore transaction object (required).
   * @param {string|null} [args.prefix=null] - Optional path prefix.
   * @returns {Promise<Function>} Function that updates the current counter.
   * @throws {Error} If transaction is not provided or autonumber is invalid.
   */
  async setAutonumber({ transaction, prefix = null } = {}) {
    if (!transaction) {
      throw new Error("transaction is required.");
    }

    try {
      let effectivePrefix =
        prefix || this.constructor.getConfig()?.prefix || "";
      if (effectivePrefix && !effectivePrefix.endsWith("/")) {
        effectivePrefix += "/";
      }
      const collectionPath = effectivePrefix + "Autonumbers";
      const docRef = doc(collection(ClientAdapter.firestore, collectionPath));
      const docSnap = await transaction.get(docRef);
      if (!docSnap.exists()) {
        throw new Error(
          `Could not find Autonumber document. collection: ${collectionPath}`
        );
      }

      const data = docSnap.data();

      if (!data?.status) {
        throw new Error(
          `Autonumber is disabled. collection: ${collectionPath}`
        );
      }

      const newNumber = data.current + 1;
      const length = data.length;
      const maxValue = Math.pow(10, length) - 1;
      if (newNumber > maxValue) {
        throw new Error(
          `The maximum value for Autonumber has been reached. collection: ${collectionPath}`
        );
      }

      const newCode = String(newNumber).padStart(length, "0");
      this[data.field] = newCode;

      return () => transaction.update(docRef, { current: newNumber });
    } catch (err) {
      console.error(
        `[ClientAdapter.js - setAutonumber] An error has occurred:`,
        err
      );
      throw err;
    }
  }

  /**
   * Returns a function to update the counter document in Firestore.
   * - This function treats 'this' as a FireModel instance.
   * @param {Object} args - Parameters for counter update.
   * @param {Object} args.transaction - Firestore transaction object (required).
   * @param {boolean} [args.increment=true] - Whether to increment (true) or decrement (false) the counter.
   * @param {string|null} [args.prefix=null] - Optional path prefix for collection.
   * @returns {Promise<Function>} Function to update the counter document.
   */
  async getCounterUpdater(args = {}) {
    const { transaction, increment = true, prefix = null } = args;
    // transaction is required
    if (!transaction) {
      throw new Error(
        "[ClientAdapter - getCounterUpdater] transaction is required."
      );
    }

    // Get collection path defined by class.
    // -> `getCollectionPath()` is a static method defined in FireModel.
    // ex) `customers` or `companies/{companyId}/customers`
    const collectionPath = this.constructor.getCollectionPath(prefix);

    // Divide collection path into segments.
    // ex) `["companies", "{companyId}", "customers"]`
    const segments = collectionPath.split("/");

    // Get collection name (Last segment is collection name)
    const colName = segments.pop();

    // Determine effective collection path for counter-document.
    const effectiveDocPath = `${segments.join("/")}/meta/docCounter`;
    const docRef = doc(ClientAdapter.firestore, effectiveDocPath);
    const docSnap = await transaction.get(docRef);
    if (!docSnap.exists()) {
      return () => transaction.set(docRef, { [colName]: increment ? 1 : 0 });
    } else {
      return () =>
        transaction.update(docRef, {
          [colName]: FieldValue_increment(increment ? 1 : -1),
        });
    }
  }

  /**
   * Create a new document in Firestore.
   * @param {Object} args - Creation options.
   * @param {string} [args.docId] - Document ID to use (optional).
   * @param {boolean} [args.useAutonumber=true] - Whether to use auto-numbering.
   * @param {Object} [args.transaction] - Firestore transaction.
   * @param {Function} [args.callBack] - Callback function.
   * @param {string} [args.prefix] - Path prefix.
   * @returns {Promise<DocumentReference>} Reference to the created document.
   * @throws {Error} If creation fails or `callBack` is not a function.
   */
  async create(args = {}) {
    const { docId, useAutonumber = true, transaction, callBack, prefix } = args;

    try {
      // `callBack` must be a function if provided.
      if (callBack && typeof callBack !== "function") {
        throw new Error(
          `[ClientAdapter.js - create] callBack must be a function.`
        );
      }

      // Pre-create hooks and validation
      await this.beforeCreate();
      await this.beforeEdit();
      this.validate();

      // transaction processing
      const performTransaction = async (txn) => {
        // Get function to update autonumber if `useAutonumber` is true.
        const updateAutonumber =
          this.constructor.useAutonumber && useAutonumber
            ? await this.setAutonumber({ transaction: txn, prefix })
            : null;

        // Get function to update counter document.
        const adapter = this.constructor.getAdapter();
        const counterUpdater = await adapter.getCounterUpdater.bind(this)({
          transaction: txn,
          increment: true,
          prefix,
        });

        // Prepare document reference
        const collectionPath = this.constructor.getCollectionPath(prefix);
        const colRef = collection(
          ClientAdapter.firestore,
          collectionPath
        ).withConverter(this.constructor.converter());
        const docRef = docId ? doc(colRef, docId) : doc(colRef);

        // Set metadata
        this.docId = docRef.id;
        this.createdAt = new Date();
        this.updatedAt = new Date();
        this.uid = ClientAdapter.auth?.currentUser?.uid || "unknown";

        // Create document
        txn.set(docRef, this);

        // Update autonumber if applicable
        if (updateAutonumber) await updateAutonumber();

        // Update counter document
        if (counterUpdater) await counterUpdater();

        // Execute callback if provided
        if (callBack) await callBack(txn);

        // Return document reference
        return docRef;
      };

      const docRef = transaction
        ? await performTransaction(transaction)
        : await runTransaction(ClientAdapter.firestore, performTransaction);

      return docRef;
    } catch (err) {
      console.error(`[ClientAdapter.js - create] An error has occurred.`, err);
      throw err;
    }
  }

  /**
   * Get a document from Firestore by its ID and load into this instance.
   * - The class properties will be cleared if the document does not exist.
   * @param {Object} args - Fetch options.
   * @param {string} args.docId - Document ID to fetch.
   * @param {Object|null} [args.transaction=null] - Firestore transaction (optional).
   * @param {string|null} [args.prefix=null] - Path prefix (optional).
   * @returns {Promise<boolean>} True if document was found and loaded, false if not found.
   * @throws {Error} If `docId` is not specified or fetch fails.
   */
  async fetch(args = {}) {
    const { docId, transaction = null, prefix = null } = args;
    try {
      if (!docId) {
        throw new Error("[ClientAdapter.js - fetch] docId is required.");
      }

      // Get collection path defined by FireModel.
      const collectionPath = this.constructor.getCollectionPath(prefix);

      // Prepare document reference.
      const colRef = collection(
        ClientAdapter.firestore,
        collectionPath
      ).withConverter(this.constructor.converter());
      const docRef = doc(colRef, docId);

      // Fetch document snapshot.
      const docSnap = transaction
        ? await transaction.get(docRef)
        : await getDoc(docRef);

      // Load data into this instance, or reset if not found.
      this.initialize(docSnap.exists() ? docSnap.data() : null);

      return docSnap.exists();
    } catch (err) {
      console.error("[ClientAdapter.js - fetch] An error has occurred:", err);
      throw err;
    }
  }

  /**
   * Get a document from Firestore by its ID and return as a new instance.
   * @param {Object} args - Fetch options.
   * @param {string} args.docId - Document ID to fetch.
   * @param {Object|null} [args.transaction=null] - Firestore transaction (optional).
   * @param {string|null} [args.prefix=null] - Path prefix (optional).
   * @returns {Promise<Object|null>} Document data, or null if not found.
   * @throws {Error} If `docId` is not specified or fetch fails.
   */
  async fetchDoc(args = {}) {
    const { docId, transaction = null, prefix = null } = args;
    try {
      // Throw error if docId is not provided.
      if (!docId) {
        throw new Error("[ClientAdapter.js - fetchDoc] 'docId' is required.");
      }

      // Get collection path defined by FireModel.
      const collectionPath = this.constructor.getCollectionPath(prefix);

      // Prepare document reference.
      const colRef = collection(
        ClientAdapter.firestore,
        collectionPath
      ).withConverter(this.constructor.converter());
      const docRef = doc(colRef, docId);

      // Fetch document snapshot.
      const docSnap = transaction
        ? await transaction.get(docRef)
        : await getDoc(docRef);

      return docSnap.exists() ? docSnap.data() : null;
    } catch (err) {
      console.error(
        "[ClientAdapter.js - fetchDoc] An error has occurred:",
        err
      );
      throw err;
    }
  }

  /**
   * Firestore のクエリ条件の配列を受け取り、Firestore のクエリオブジェクト配列を生成して返します。
   * - `constraints` 配列には、`where`, `orderBy`, `limit` などの Firestore クエリを指定できます。
   * - 例：`[['where', 'age', '>=', 18], ['orderBy', 'age', 'desc'], ['limit', 10]]`
   * - 不明なクエリタイプが指定された場合はエラーをスローします。
   *
   * @param {Array} constraints - クエリ条件の配列です。
   * @returns {Array<Object>} - Firestore クエリオブジェクトの配列を返します。
   * @throws {Error} - 不明なクエリタイプが指定された場合、エラーをスローします。
   */
  createQueries(constraints) {
    const result = [];
    const validQueryTypes = ["where", "orderBy", "limit"];

    constraints.forEach((constraint) => {
      const [type, ...args] = constraint;

      switch (type) {
        case "where":
          result.push(where(...args));
          break;
        case "orderBy":
          if (!["asc", "desc"].includes(args[1] || "asc")) {
            console.error(
              "[ClientAdapter.js - createQueries] Invalid orderBy direction:",
              args[1]
            );
            throw new Error(
              `Invalid orderBy direction: ${args[1]}. Use "asc" or "desc".`
            );
          }
          result.push(orderBy(args[0], args[1] || "asc"));
          break;
        case "limit":
          if (typeof args[0] !== "number" || args[0] <= 0) {
            console.error(
              "[ClientAdapter.js - createQueries] Invalid limit value:",
              args[0]
            );
            throw new Error(
              `Invalid limit value: ${args[0]}. Must be a positive number.`
            );
          }
          result.push(limit(args[0]));
          break;
        default:
          console.error(
            "[ClientAdapter.js - createQueries] Invalid query type:",
            type
          );
          throw new Error(
            `Invalid query type: ${type}. Please use one of: ${validQueryTypes.join(
              ", "
            )}`
          );
      }
    });
    return result;
  }

  /**
   * Firestore の `tokenMap` に基づく N-Gram 検索用のクエリオブジェクトを生成します。
   * - 検索文字列の 1 文字・2 文字ごとのトークンを作成し、Firestore の `tokenMap` を利用した検索クエリを生成します。
   * - 例：`"検索"` → `['検', '索', '検索']`
   * - サロゲートペア文字（絵文字など）は Firestore の `tokenMap` では検索対象としないため除外します。
   *
   * @param {string} constraints - 検索に使用する文字列です。
   * @returns {Array<Object>} - Firestore クエリオブジェクトの配列を返します。
   * @throws {Error} - `constraints` が空文字の場合、エラーをスローします。
   */
  createTokenMapQueries(constraints) {
    if (!constraints || constraints.trim().length === 0) {
      throw new Error("Search string (constraints) cannot be empty.");
    }

    const result = new Set(); // クエリの重複を防ぐために `Set` を使用

    // サロゲートペア文字（絵文字など）を除外
    const target = constraints.replace(
      /[\uD800-\uDBFF]|[\uDC00-\uDFFF]|~|\*|\[|\]|\s+/g,
      ""
    );

    // 1 文字・2 文字のトークンを生成
    const tokens = [
      ...new Set([
        ...[...target].map((_, i) => target.substring(i, i + 1)), // 1 文字トークン
        ...[...target].map((_, i) => target.substring(i, i + 2)).slice(0, -1), // 2 文字トークン
      ]),
    ];

    // Firestore クエリオブジェクトを作成
    tokens.forEach((token) => {
      result.add(where(`tokenMap.${token}`, "==", true));
    });

    return Array.from(result); // `Set` を配列に変換して返す
  }

  /**
   * クエリ条件に一致するドキュメントを Firestore から取得します。
   * - `constraints` が文字列なら N-gram 検索を実行します。
   * - 配列なら通常のクエリ検索を行います。
   * - `prefix` が指定されている場合は、コレクションパスの解決に使用されます。
   *
   * [NOTE]
   * - 2025/06/04 現在、transaction.get() に Query を指定すると以下のエラーが発生。
   *   Cannot read properties of undefined (reading 'path')
   *   原因が不明なため、`transaction` が指定されている場合は警告を出力するとともに
   *   getDocs() を使った処理に差し替えることとする。
   *
   * @param {Object} args - Fetch options.
   * @param {Array|string} args.constraints - Query condition array or search string.
   * @param {Array} [args.options=[]] - Additional query filters (ignored if constraints is an array).
   * @param {Object|null} [args.transaction=null] - Firestore transaction (optional).
   * @param {string|null} [args.prefix=null] - Optional Firestore path prefix.
   * @returns {Promise<Array<Object>>} Array of document data.
   * @throws {Error} If constraints are invalid or Firestore query fails.
   */
  async fetchDocs({
    constraints = [],
    options = [],
    transaction = null,
    prefix = null,
  } = {}) {
    const queryConstraints = [];

    if (typeof constraints === "string") {
      queryConstraints.push(...this.createTokenMapQueries(constraints));
      queryConstraints.push(...this.createQueries(options));
    } else if (Array.isArray(constraints)) {
      queryConstraints.push(...this.createQueries(constraints));
    } else {
      throw new Error(`constraints must be a string or array.`);
    }

    try {
      const collectionPath = this.constructor.getCollectionPath(prefix);
      const colRef = collection(
        ClientAdapter.firestore,
        collectionPath
      ).withConverter(this.constructor.converter());

      const queryRef = query(colRef, ...queryConstraints);

      let querySnapshot;

      // do not use transaction.
      if (transaction) {
        console.warn(
          "[ClientAdapter.js - fetchDocs] A transaction was provided, but transaction.get(Query) is known to cause an error. Falling back to getDocs(). This read operation will NOT be part of the transaction."
        );
        querySnapshot = await getDocs(queryRef);
      } else {
        querySnapshot = await getDocs(queryRef);
      }

      return querySnapshot.docs.map((doc) => doc.data());
    } catch (err) {
      console.error(
        "[ClientAdapter.js - fetchDocs] An error has occurred:",
        err
      );
      throw err;
    }
  }

  /**
   * 指定されたドキュメント ID の配列に該当するドキュメントを取得して返します。
   * - `prefix` が指定されている場合は、コレクションパスの解決に使用されます。
   *
   * [NOTE]
   * - 2025/06/04 現在、transaction.get() に Query を指定すると以下のエラーが発生。
   *   Cannot read properties of undefined (reading 'path')
   *   原因が不明なため、`transaction` が指定されている場合は警告を出力するとともに
   *   getDocs() を使った処理に差し替えることとする。
   *
   * @param {Object} args - Fetch options.
   * @param {Array<string>} args.ids - Document ID の配列。
   * @param {Object|null} [args.transaction=null] - Firestore transaction (optional).
   * @param {string|null} [args.prefix=null] - Optional Firestore path prefix.
   * @returns {Promise<Array<Object>>} Array of document data.
   */
  async fetchDocsByIds({ ids = [], transaction = null, prefix = null } = {}) {
    try {
      if (!Array.isArray(ids) || ids.length === 0) return [];

      const uniqueIds = Array.from(new Set(ids));
      const chunkedIds = uniqueIds.flatMap((_, i, a) => {
        return i % 30 ? [] : [a.slice(i, i + 30)];
      });

      const collectionPath = this.constructor.getCollectionPath(prefix);
      const colRef = collection(
        ClientAdapter.firestore,
        collectionPath
      ).withConverter(this.constructor.converter());

      let querySnapshotArray;

      // do not use transaction.
      if (transaction) {
        console.warn(
          "[ClientAdapter.js - fetchDocsByIds] A transaction was provided, but transaction.get(Query) is known to cause an error. Falling back to getDocs(). This read operation will NOT be part of the transaction."
        );
        querySnapshotArray = await Promise.all(
          chunkedIds.map((chunkedId) => {
            const q = query(colRef, where("docId", "in", chunkedId));
            return getDocs(q);
          })
        );
      } else {
        querySnapshotArray = await Promise.all(
          chunkedIds.map((chunkedId) => {
            const q = query(colRef, where("docId", "in", chunkedId));
            return getDocs(q);
          })
        );
      }

      return querySnapshotArray.flatMap((snapshot) =>
        snapshot.docs.map((doc) => doc.data())
      );
    } catch (err) {
      console.error(
        "[ClientAdapter.js - fetchDocsByIds] An error has occurred:",
        err
      );
      throw err;
    }
  }

  /**
   * Updates the Firestore document using the current instance data.
   * - Requires `this.docId` to be set (must call `fetch()` beforehand).
   * - Runs inside a transaction. If not provided, a new one will be created.
   * - If `callBack` is specified, it will be executed after the update.
   * - If `prefix` is provided, it is used to resolve the collection path.
   *
   * Firestore ドキュメントを現在のプロパティ値で更新します。
   * - `this.docId` が設定されていない場合はエラーになります（事前に `fetch()` を実行してください）。
   * - 更新はトランザクション内で行われます。トランザクションが指定されない場合は新たに生成されます。
   * - `callBack` が指定されていれば、更新後に実行されます。
   * - `prefix` が指定されている場合は、コレクションパスの解決に使用されます。
   *
   * @param {Object} args - Parameters for update operation.
   *                        更新処理のためのパラメータ。
   * @param {Object|null} [args.transaction=null] - Firestore transaction object.
   *                                                Firestore のトランザクションオブジェクト。
   * @param {function|null} [args.callBack=null] - Callback executed after update.
   *                                               更新後に実行されるコールバック関数。
   * @param {string|null} [args.prefix=null] - Optional Firestore path prefix.
   *                                           コレクションパスのプレフィックス（任意）。
   * @returns {Promise<DocumentReference>} Reference to the updated document.
   *                                       更新されたドキュメントのリファレンス。
   * @throws {Error} If `docId` is not set, or if `callBack` is not a function.
   *                 `docId` が未設定、または `callBack` が関数でない場合にスローされます。
   */
  async update({ transaction = null, callBack = null, prefix = null } = {}) {
    if (callBack !== null && typeof callBack !== "function") {
      throw new Error(`callBack must be a function.`);
    }

    if (!this.docId) {
      throw new Error(
        `The docId property is required for update(). Call fetch() first.`
      );
    }

    try {
      await this.beforeUpdate();
      await this.beforeEdit();
      this.validate();

      const performTransaction = async (txn) => {
        const collectionPath = this.constructor.getCollectionPath(prefix);
        const colRef = collection(
          ClientAdapter.firestore,
          collectionPath
        ).withConverter(this.constructor.converter());
        const docRef = doc(colRef, this.docId);

        this.updatedAt = new Date();
        this.uid = ClientAdapter.auth?.currentUser?.uid || "unknown";

        txn.set(docRef, this);
        if (callBack) await callBack(txn);
        return docRef;
      };

      const docRef = transaction
        ? await performTransaction(transaction)
        : await runTransaction(ClientAdapter.firestore, performTransaction);

      return docRef;
    } catch (err) {
      console.error(`[ClientAdapter.js - update] ${err.message}`);
      throw err;
    }
  }

  /**
   * Checks if any child documents exist for this document, based on `hasMany` configuration.
   * - For collections, the prefix is applied to the collection path.
   *
   * `hasMany` 設定に基づいて、このドキュメントに従属する子ドキュメントが存在するかを確認します。
   * - コレクションタイプの定義に対しては `prefix` がパスに適用されます。
   *
   * [NOTE]
   * - 2025/06/04 現在、transaction.get() に Query を指定すると以下のエラーが発生。
   *   Cannot read properties of undefined (reading 'path')
   *   原因が不明なため、`transaction` が指定されている場合は警告を出力するとともに
   *   getDocs() を使った処理に差し替えることとする。
   *
   * @param {Object} args - Options for the check.
   * @param {Object|null} [args.transaction=null] - Firestore transaction object (optional).
   * @param {string|null} [args.prefix=null] - Optional path prefix for resolving collections.
   * @returns {Promise<object|boolean>} Matching `hasMany` item if found, otherwise false.
   * @throws {Error} If `docId` is not set or query fails.
   */
  async hasChild({ transaction = null, prefix = null } = {}) {
    if (!this.docId) {
      throw new Error(
        `The docId property is required for delete(). Call fetch() first.`
      );
    }

    try {
      for (const item of this.constructor.hasMany) {
        const collectionPath =
          item.type === "collection" && prefix
            ? `${prefix}${item.collectionPath}`
            : item.collectionPath;
        const colRef =
          item.type === "collection"
            ? collection(ClientAdapter.firestore, collectionPath)
            : collectionGroup(ClientAdapter.firestore, item.collectionPath);
        const constraint = where(item.field, item.condition, this.docId);
        const queryRef = query(colRef, constraint, limit(1));

        let snapshot;
        if (transaction) {
          // JSDocの[NOTE]に記載の通り、transaction.get(Query) はエラーが発生するため、
          // getDocs() を使用します。この場合、読み取りはトランザクションの一部として実行されません。
          console.warn(
            "[ClientAdapter.js - hasChild] A transaction was provided, but transaction.get(Query) is known to cause an error. Falling back to getDocs(). This read operation will NOT be part of the transaction."
          );
          snapshot = await getDocs(queryRef);
        } else {
          snapshot = await getDocs(queryRef);
        }

        if (!snapshot.empty) return item;
      }

      return false;
    } catch (error) {
      console.error(
        `[ClientAdapter.js - hasChild] An error has occurred:`,
        error
      );
      throw error;
    }
  }

  /**
   * Deletes the document corresponding to the current `docId`.
   * - If `logicalDelete` is enabled, the document is moved to an archive collection instead of being permanently deleted.
   * - If `transaction` is provided, the deletion is executed within it.
   * - If `prefix` is provided, it will be used to resolve the collection path.
   *
   * 現在の `docId` に該当するドキュメントを削除します。
   * - `logicalDelete` が true の場合、ドキュメントは物理削除されず、アーカイブコレクションに移動されます。
   * - `transaction` が指定されている場合、その中で処理が実行されます。
   * - `prefix` が指定されている場合、それを使ってコレクションパスを解決します。
   *
   * @param {Object} args - Parameters for deletion.
   *                        削除処理のパラメータ。
   * @param {Object|null} [args.transaction=null] - Firestore transaction object (optional).
   *                                                Firestore のトランザクションオブジェクト（任意）。
   * @param {function|null} [args.callBack=null] - Callback executed after deletion (optional).
   *                                               削除後に実行されるコールバック関数（任意）。
   * @param {string|null} [args.prefix=null] - Optional Firestore path prefix.
   *                                           コレクションパスのプレフィックス（任意）。
   * @returns {Promise<void>} Resolves when deletion is complete.
   *                          削除が完了したら解決されるプロミス。
   * @throws {Error} If `docId` is missing, `callBack` is not a function, or document is undeletable.
   *                 `docId` が未設定、`callBack` が関数でない、または削除対象のドキュメントが存在しない場合。
   */
  async delete({ transaction = null, callBack = null, prefix = null } = {}) {
    if (callBack !== null && typeof callBack !== "function") {
      throw new Error(`callBack must be a function.`);
    }

    if (!this.docId) {
      throw new Error(
        `The docId property is required for delete(). Call fetch() first.`
      );
    }

    try {
      await this.beforeDelete();

      const collectionPath = this.constructor.getCollectionPath(prefix);
      const colRef = collection(ClientAdapter.firestore, collectionPath);
      const docRef = doc(colRef, this.docId);

      const performTransaction = async (txn) => {
        // Check for child documents before deletion
        // If child documents exist, throw an error to prevent deletion
        const hasChild = await this.hasChild({
          transaction: txn,
          prefix: prefix || this.constructor?.config?.prefix,
        });
        if (hasChild) {
          throw new Error(
            `Cannot delete because the associated document exists in the ${hasChild.collectionPath} collection.`
          );
        }

        // Get function to update counter document.
        const adapter = this.constructor.getAdapter();
        const counterUpdater = await adapter.getCounterUpdater.bind(this)({
          transaction: txn,
          increment: false,
          prefix,
        });

        // If logicalDelete is enabled, archive the document before deletion
        if (this.constructor.logicalDelete) {
          // Fetch the document to be deleted
          // This is necessary because in a transaction, docRef.get() cannot be used directly
          // and we need to ensure the document exists before archiving
          const sourceDocSnap = await txn.get(docRef);
          if (!sourceDocSnap.exists()) {
            throw new Error(
              `The document to be deleted did not exist. The document ID is ${this.docId}.`
            );
          }

          const sourceDocData = sourceDocSnap.data();
          const archiveColRef = collection(
            ClientAdapter.firestore,
            `${collectionPath}_archive`
          );
          const archiveDocRef = doc(archiveColRef, this.docId);
          txn.set(archiveDocRef, sourceDocData);
        }

        txn.delete(docRef);

        if (counterUpdater) await counterUpdater();

        if (callBack) await callBack(txn);
      };

      if (transaction) {
        await performTransaction(transaction);
      } else {
        await runTransaction(ClientAdapter.firestore, performTransaction);
      }
    } catch (err) {
      console.error(`[ClientAdapter.js - delete] An error has occurred.`);
      throw err;
    }
  }

  /**
   * Restores a deleted document from the archive collection to the original collection.
   * - Uses `prefix` to resolve the Firestore collection path.
   *
   * アーカイブコレクションから削除されたドキュメントを元のコレクションに復元します。
   * - `prefix` が指定されていれば、それに基づいてコレクションパスを解決します。
   *
   * @param {Object} args - Restore options.
   * @param {string} args.docId - Document ID to restore.
   * @param {string|null} [args.prefix=null] - Optional path prefix.
   * @returns {Promise<DocumentReference>} Reference to the restored document.
   * @throws {Error} If document is not found in the archive.
   */
  async restore({ docId, prefix = null, transaction = null } = {}) {
    try {
      if (!docId) throw new Error(`docId is required.`);
      const performTransaction = async (txn) => {
        const collectionPath = this.constructor.getCollectionPath(prefix);
        const archivePath = `${collectionPath}_archive`;
        const archiveColRef = collection(ClientAdapter.firestore, archivePath);
        const archiveDocRef = doc(archiveColRef, docId);
        const docSnapshot = await txn.get(archiveDocRef);
        if (!docSnapshot.exists()) {
          throw new Error(
            `Specified document is not found at ${archivePath}. docId: ${docId}`
          );
        }

        // Get function to update counter document.
        const adapter = this.constructor.getAdapter();
        const counterUpdater = await adapter.getCounterUpdater.bind(this)({
          transaction: txn,
          increment: true,
          prefix,
        });

        const colRef = collection(ClientAdapter.firestore, collectionPath);
        const docRef = doc(colRef, docId);
        txn.delete(archiveDocRef);
        txn.set(docRef, docSnapshot.data());

        if (counterUpdater) await counterUpdater();

        return docRef;
      };

      if (transaction) {
        return await performTransaction(transaction);
      } else {
        return await runTransaction(
          ClientAdapter.firestore,
          performTransaction
        );
      }
    } catch (err) {
      console.error(`[ClientAdapter.js - restore] An error has occurred.`);
      throw err;
    }
  }

  /**
   * Unsubscribes from the active Firestore real-time listener, if one exists.
   * - Also clears the local document array (`this.docs`).
   *
   * Firestore のリアルタイムリスナーを解除します。
   * - 現在のリスナーが存在する場合、それを解除します。
   * - さらに、`this.docs` に格納されていたドキュメントデータもクリアします。
   *
   * @returns {void}
   */
  unsubscribe() {
    if (this.listener) {
      this.listener();
      this.listener = null;
    }
    this.docs.splice(0);
  }

  /**
   * Sets a real-time listener on a Firestore document and initializes the instance with its data.
   * - If a listener already exists, it will be unsubscribed first.
   *
   * Firestore のドキュメントに対してリアルタイムリスナーを設定し、
   * ドキュメントのデータでインスタンスを初期化します。
   *
   * @param {Object} args - Subscribe options.
   * @param {string} args.docId - Document ID to subscribe to.
   * @param {string|null} [args.prefix=null] - Optional path prefix.
   * @returns {void}
   * @throws {Error} If docId is missing.
   */
  subscribe({ docId, prefix = null } = {}) {
    this.unsubscribe();

    if (!docId) throw new Error(`docId is required.`);

    try {
      const collectionPath = this.constructor.getCollectionPath(prefix);
      // const colRef = collection(ClientAdapter.firestore, collectionPath);
      const colRef = collection(
        ClientAdapter.firestore,
        collectionPath
      ).withConverter(this.constructor.converter());
      const docRef = doc(colRef, docId);
      this.listener = onSnapshot(docRef, (docSnapshot) => {
        this.initialize(docSnapshot.data());
      });
    } catch (err) {
      console.error(`[ClientAdapter.js - subscribe] An error has occurred.`);
      throw err;
    }
  }

  /**
   * Sets a real-time listener on a Firestore collection and monitors changes.
   * - If `constraints` is a string, performs N-gram search using `tokenMap`.
   * - If `constraints` is an array, applies Firestore query conditions.
   * - If `prefix` is provided, it is used to resolve the collection path.
   *
   * Firestore コレクションに対してリアルタイムリスナーを設定し、
   * ドキュメントの変更を監視します。
   *
   * @param {Object} args - Subscribe options.
   * @param {Array|string} args.constraints - Query condition array or search string.
   * @param {Array} [args.options=[]] - Additional query conditions.
   * @param {string|null} [args.prefix=null] - Optional path prefix.
   * @param {function|null} [args.callback=null] - Callback executed on document changes.
   * @returns {Array<Object>} Live-updated document data.
   */
  subscribeDocs({
    constraints = [],
    options = [],
    prefix = null,
    callback,
  } = {}) {
    this.unsubscribe();
    const queryConstraints = [];

    if (typeof constraints === "string") {
      queryConstraints.push(...this.createTokenMapQueries(constraints));
      queryConstraints.push(...this.createQueries(options));
    } else if (Array.isArray(constraints)) {
      queryConstraints.push(...this.createQueries(constraints));
    } else {
      throw new Error(`constraints must be a string or array.`);
    }

    try {
      const collectionPath = this.constructor.getCollectionPath(prefix);
      const colRef = collection(
        ClientAdapter.firestore,
        collectionPath
      ).withConverter(this.constructor.converter());
      const queryRef = query(colRef, ...queryConstraints);

      this.listener = onSnapshot(queryRef, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          const item = change.doc.data();
          const index = this.docs.findIndex(
            ({ docId }) => docId === item.docId
          );
          if (change.type === "added") this.docs.push(item);
          if (change.type === "modified") this.docs.splice(index, 1, item);
          if (change.type === "removed") this.docs.splice(index, 1);
          if (callback) callback(item, change.type);
        });
      });

      return this.docs;
    } catch (err) {
      console.error(
        `[ClientAdapter.js - subscribeDocs] An error has occurred.`
      );
      throw err;
    }
  }
}

export default ClientAdapter;
