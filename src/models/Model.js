import { isFn, isString } from "@webbower/stdlib/lang";
/**
 * @todo
 * ```js
 * const ChecklistItemConfig = Model.extend({
 * 	name: 'ChecklistItemConfig',
 * 	// could also support Types
 * 	fields: {
 * 		id: isString,
 * 		title: isString,
 * 		tags: isList(isString),
 * 	},
 * 	init: ({
 *    id = createId(),
 *    title = "",
 *    tags = [],
 *  }) => {
 * 		// fields is only the fields listed above. You have the opportunity to set
 *    // defaults and preprocess raw data. Validation is run on the returned
 *    // object.
 * 	},
 * 	proto: {},
 * 	stat: {},
 * });
 * ```
 */

const createPrototypeDescriptor = (value) => {
	if (typeof value === "function") {
		return {
			value,
			configurable: true,
		};
	}

	// TODO handle object descriptor values to allow intermixing of proto definition
	return { value };
};

const createStaticDescriptor = (value) => {
	if (typeof value === "function") {
		return {
			value,
			configurable: true,
		};
	}

	// TODO handle object descriptor values to allow intermixing of proto definition
	return { value };
};

const AnonymousModel = (data = {}) => {
	return Object.assign(Object.create(AnonymousModel.prototype), data);
};

/**
 * @callback ModelConstructor
 * @param {Object} data The raw data to assign to the model instance
 * @returns {Object} The object data for the instance
 *
 * @typedef {Object} ExtendConfigArg
 * @prop {string} name The name of the Model
 * @prop {ModelConstructor} ctor The Constructor definition
 * @prop {Object} [proto] The prototype object of the Model
 * @prop {Object} [stat] Static properties and functions on the Model constructor
 */
Object.assign(AnonymousModel, {
	prototype: Object.assign(Object.create(Object.prototype), {
		constructor: AnonymousModel,
		/**
		 * inst.merge({
		 *   key: newValue,
		 *   other: otherValue,
		 * });
		 *
		 * Combines {@link partialFields} with the current fields (partial fields take
		 * priority) and passes the result into the constructor.
		 */
		merge(partialFields) {
			return this.constructor({
				...this,
				...Object(partialFields),
			});
		},
		map(fn = (x) => x) {
			return this.constructor(fn(this));
		},
		/**
		 * inst.update(inst => ({
		 *   key: inst.key === 'foo' ? 1 : 2,
		 * }));
		 *
		 * Calls {@link updaterFn} with the current instance and merges the returned
		 * partial fields onto it via {@link Model#merge}.
		 */
		update(updaterFn) {
			return this.merge(updaterFn(this));
		},
		/**
		 * inst.setField('key', newValue)
		 *
		 * Sets a single field to a new value via {@link Model#merge}.
		 */
		setField(fieldName, newValue) {
			return this.merge({ [fieldName]: newValue });
		},
		clone() {
			return this.map(({ id: _ignored, ...rest }) => rest);
		},
	}),
	// /**
	//  * Create a subclass of the Model class that is connected in the prototype chain to all parent classes
	//  *
	//  * @param {ModelConstructor | string | ExtendConfigArg} namedCtorOrCtorNameOrConfig Either the named ctor function, the string name when {@link unnamedCtor} is provided, or the full config object
	//  * @param {ModelConstructor} unnamedCtor The unnamed constructor function when {@link namedCtorOrCtorNameOrConfig} is a string
	//  * @returns {ModelConstructor} The new Model constructor
	//  */
	// extend(namedCtorOrCtorNameOrConfig, unnamedCtor) {
	// 	const { ctor, name, proto = {}, stat = {} } = arguments.length === 2 && isFunction(unnamedCtor)
	// 		? { ctor: unnamedCtor, name: String(namedCtorOrCtorNameOrConfig) }
	// 		: isFunction(namedCtorOrCtorNameOrConfig)
	// 		? { ctor: namedCtorOrCtorNameOrConfig, name: namedCtorOrCtorNameOrConfig.name = "" }
	// 		: namedCtorOrCtorNameOrConfig;
	/**
	 * @typedef {Object} ModelExtendConfig The full Model config as an object
	 * @param {(object) => Model} ctor The constructor function that receives an object and returns an object of Model properties
	 * @param {string} [name=null] The name of the Model. Overrides the built-in `.name` of {@link ctor}
	 * @param {Object} [proto={}] The prototype object of the Model
	 * @param {Object} [stat={}] Static properties and functions on the Model constructor
	 */
	/**
	 * Create a subclass of the Model class that is connected in the prototype chain to all parent classes
	 *
	 * `Model.extend()` supports 3 signatures:
	 * 1. Only a named constructor function
	 * ```js
	 * const User = Model.extend(function User({
	 *   id = createdId(),
	 *   email = '',
	 *   password = '',
	 * }) {
	 *   return {
	 *     id,
	 *     email,
	 *     password,
	 *   }
	 * })
	 * ```
	 * 2. A string name for the model and a named or unnamed constructor function
	 * ```js
	 * const User = Model.extend('User', ({
	 *   id = createdId(),
	 *   email = '',
	 *   password = '',
	 * }) => ({
	 *   id,
	 *   email,
	 *   password,
	 * }))
	 * ```
	 * 3. A full config object to define the name, constructor, prototype, and static properties
	 * ```js
	 * const User = Model.extend({
	 *   name: 'User',
	 *   ctor: ({
	 *     id = createdId(),
	 *     email = '',
	 *     password = '',
	 *   }) => ({
	 *     id,
	 *     email,
	 *     password,
	 *   }),
	 *   proto: {
	 *     toJSON() {
	 *       return {...this};
	 *     }
	 *   },
	 *   stat: {
	 *     fromJSON(json) {
	 *       return User(json);
	 *     }
	 *   },
	 * })
	 * ```
	 *
	 * @param {ModelExtendConfig | ModelExtendConfig.name | ModelExtendConfig.ctor} aConfig_bCtorName_cNamedCtor
	 * @param {ModelExtendConfig.ctor} [bUnnamedCtor]
	 * @returns {Function} The new Model constructor
	 */
	extend(aConfig_bCtorName_cNamedCtor, bUnnamedCtor) {
		// Normalize polymorphic signature
		const { ctor, name = "", proto = {}, stat = {} } =
			isString(aConfig_bCtorName_cNamedCtor) && isFn(bUnnamedCtor)
				? { ctor: bUnnamedCtor, name: aConfig_bCtorName_cNamedCtor }
				: isFn(aConfig_bCtorName_cNamedCtor)
				? { ctor: aConfig_bCtorName_cNamedCtor, name: aConfig_bCtorName_cNamedCtor.name }
				: aConfig_bCtorName_cNamedCtor;

		// deno-lint-ignore no-this-alias
		const parent = this;

		const constructor = (data = {}) => {
			return Object.freeze(Object.assign(
				Object.create(constructor.prototype),
				ctor(data),
			));
		};
		// const constructor = (data = {}) => {
		// 	return Object.create(
		// 		constructor.prototype,
		// 		Object.entries(ctor(data)).reduce(
		// 			(descriptors, [key, value]) => ((descriptors[key] = { value, enumerable: true }), descriptors),
		// 			{},
		// 		),
		// 	);
		// };

		const protoDescriptors = Object.entries(Object.getOwnPropertyDescriptors(proto)).reduce(
			// NOTE We don't allow `set` because that would break the immutable design of this module
			(final, [key, { value, get }]) => {
				if (get) {
					final[key] = { get, configurable: true, enumerable: true };
				} else {
					final[key] = createPrototypeDescriptor(value);
				}
				return final;
			},
			{},
		);

		// TODO Smarten prototype symbol handling
		Object.getOwnPropertySymbols(proto).forEach((sym) => {
			let extraDtors = {};
			switch (sym) {
				case Symbol.iterator:
					extraDtors = {
						writable: true,
						configurable: true,
					};
					break;
				case Symbol.toPrimitive:
					extraDtors = {
						configurable: true,
					};
					break;
			}

			protoDescriptors[sym] = {
				value: proto[sym],
				...extraDtors,
			};
		});

		constructor.prototype = Object.create(parent.prototype, {
			constructor: createPrototypeDescriptor(constructor),
			...protoDescriptors,
		});

		// TODO handle symbol keys
		const statDescriptors = Object.entries(stat).reduce(
			(final, [key, value]) => ((final[key] = createStaticDescriptor(value)), final),
			{},
		);

		const ctorName = `${name || ctor.name || "Unnamed"}Model`;
		return Object.defineProperties(constructor, {
			name: { value: ctorName },
			...statDescriptors,
		});
	},
	// extend(ctor, { proto = {}, mixins = [], stat = {}, name = null } = {}) {
	//   const parent = this;

	//   const constructor = (data = {}) => {
	//     return {
	//       ...ctor(data),
	//       ...parent.constructor(data),
	//     };
	//   };

	//   const finalProto = mixins.reduce(
	//     (final, mixin) => Object.assign(final, mixin),
	//     Object.assign(Object.create(Object.getPrototypeOf(this.prototype)), proto)
	//   );

	//   Object.assign(constructor, stat, {
	//     constructor,
	//     prototype: finalProto,
	//   });

	//   if (process.env.NODE_ENV !== 'production') {
	//     if (!ctor.name && !name) {
	//       console.warn(`${parent.name}.extend() unable to determine name for subclass`);
	//     }
	//   }
	//   const ctorName = `${ctor.name || name || 'UnnamedModel'}Model`;
	//   return Object.defineProperty(constructor, 'name', { value: ctorName });
	// },
});

export { AnonymousModel as Model };
