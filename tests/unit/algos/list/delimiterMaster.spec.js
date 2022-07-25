'use strict'; // eslint-disable-line strict

const assert = require('assert');
const chance = require('chance').Chance(); // eslint-disable-line

const { getCommonPrefix } = require('../../../../lib/algos/list/delimiter');
const DelimiterMaster =
    require('../../../../lib/algos/list/delimiterMaster').DelimiterMaster;
const {
    FILTER_ACCEPT,
    FILTER_SKIP,
    SKIP_NONE,
    inc,
} = require('../../../../lib/algos/list/tools');
const VSConst =
    require('../../../../lib/versioning/constants').VersioningConstants;
const Version = require('../../../../lib/versioning/Version').Version;
const { generateVersionId } = require('../../../../lib/versioning/VersionID');
const { DbPrefixes } = VSConst;
const zpad = require('../../helpers').zpad;
const VID_SEP = VSConst.VersionId.Separator;
const EmptyResult = {
    CommonPrefixes: [],
    Contents: [],
    IsTruncated: false,
    NextMarker: undefined,
    Delimiter: undefined,
};

const fakeLogger = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
};

function getListingKey(key, vFormat) {
    if (vFormat === 'v0') {
        return key;
    }
    if (vFormat === 'v1') {
        return `${DbPrefixes.Master}${key}`;
    }
    return assert.fail(`bad vFormat ${vFormat}`);
}

const MAX_STREAK_LENGTH = 100;

function createStreakState(prefix, vFormat) {
    return {
        vFormat,
        prefix,
        prefixes: new Set(),
        params: {},
        streakLength: 0,
        gteparams: null,
    };
}

/**
 * Simplified version of logic found in Metadata's RepdServer. When MAX_STREAK_LENGTH (typically 100)
 * is reached, we attempt to skip to the next listing range as a performance optimization.
 * @param {Integer} filteringResult - 0, 1, -1 indicating if we can skip to the next character range.
 * @param {String} skippingRange - lower bound that the listing can begin from.
 * @returns {undefined}
 */
/* eslint-disable no-param-reassign */
function handleStreak(filteringResult, skippingRange, state) {
    if (filteringResult < 0) {
        // readStream would be destroyed. In this mock, we just continue.
    } else if (filteringResult === 0 && skippingRange) {
        // check if MAX_STREAK_LENGTH consecutive keys have been
        // skipped
        if (++state.streakLength === MAX_STREAK_LENGTH) {
            if (Array.isArray(skippingRange)) {
                // With synchronized listing, the listing
                // algo backend skipping() function must
                // return as many skip keys as listing
                // param sets.
                for (let i = 0; i < skippingRange.length; ++i) {
                    state.params[i].gte = inc(skippingRange[i]);
                }
            } else {
                state.params.gte = inc(skippingRange);
            }
            if (state.gteparams && state.gteparams === state.params.gte) {
                state.streakLength = 1;
            } else {
                // stop listing this key range
                state.gteparams = state.params.gte;
            }
        }
    } else {
        state.streakLength = 1;
    }
}/* eslint-enable */

/**
 * Generate a random number of versioned keys.
 * @param {String} masterKey - base key used to derive version keys
 * @param {Integer} numKeys - how many versioned keys to generate
 * @param {Object} state - test case state
 * @yields {Object} - { key, isDeleteMarker }
 * @returns {undefined}
 */
function *generateVersionedKeys(masterKey, numKeys, state) {
    for (let i = 0; i < numKeys; i++) {
        yield {
            key: `${masterKey}${VID_SEP}${zpad(i)}`,
            isDeleteMarker: state.vFormat === 'v0' && chance.bool(),
            canSkip: true,
        };
    }
}

/**
 * Generate raw listing keys in alphabetical order.
 * @param {Integer} count - how many keys to generate.
 * @param {Object} state - state for test run.
 * @yields {Object} - { key, isDeleteMarker }
 */

function *generateKeys(count, state) {
    let idx = 0;
    let masterKey = '_Common-Prefix/';
    yield { key: masterKey, isDeleteMarker: false, canSkip: false };

    idx++;
    while (idx < count) {
        masterKey = `_Common-Prefix/${zpad(idx)}`;
        const masterKeyWithSubprefix = `_Common-Prefix/${zpad(idx)}/${zpad(idx)}`;

        const hasSubprefix = chance.bool();
        const isDeleteMarker = state.vFormat === 'v0' && chance.bool();
        const baseKey = hasSubprefix ? masterKeyWithSubprefix : masterKey;

        let canSkip = isDeleteMarker;
        if (hasSubprefix || state.prefix[state.prefix.length - 1] !== '/') {
            canSkip = canSkip || state.handleSubprefixKey(baseKey);
        }

        yield { key: baseKey, isDeleteMarker, canSkip };
        idx++;

        const versioned = chance.integer({ min: 0, max: 200 });
        const allowedVersionedKeys = Math.min(count - idx, versioned);
        yield* generateVersionedKeys(baseKey, allowedVersionedKeys, state);
        idx += allowedVersionedKeys;
    }
}

['v0', 'v1'].forEach(vFormat => {
    describe(`Delimiter All masters listing algorithm vFormat=${vFormat}`, () => {
        it('should return SKIP_NONE for DelimiterMaster when both NextMarker ' +
        'and NextContinuationToken are undefined', () => {
            const delimiter = new DelimiterMaster({ delimiter: '/' }, fakeLogger, vFormat);

            assert.strictEqual(delimiter.NextMarker, undefined);

            // When there is no NextMarker or NextContinuationToken, it should
            // return SKIP_NONE
            assert.strictEqual(delimiter.skipping(), SKIP_NONE);
        });

        it('should list all subprefixes when handleStreak is applied as in RepdServer', () => {
            ['_Common-Prefix', '_Common-Prefix/'].forEach(prefix => {
                const state = createStreakState(prefix, vFormat);
                state.handleSubprefixKey = baseKey => {
                    const isLastDelim = state.prefix[state.prefix.length - 1] === '/';
                    const lastIdx = isLastDelim ? baseKey.lastIndexOf('/') : state.prefix.length;
                    const prefix = isLastDelim ? getCommonPrefix(baseKey, '/', lastIdx) : baseKey.slice(0, lastIdx);
                    if (state.prefixes.has(prefix) || (!isLastDelim && baseKey.length > lastIdx)) {
                        return true;
                    }

                    state.prefixes.add(prefix);
                    return false;
                };

                const maxKeys = 1000000;
                const delimiter = new DelimiterMaster({
                    maxKeys,
                    prefix,
                    delimiter: '/',
                    startAfter: '',
                    continuationToken: '',
                    v2: true,
                    fetchOwner: false }, fakeLogger, vFormat);

                [...generateKeys(maxKeys, state)].forEach(ob => {
                    const { key, isDeleteMarker, canSkip } = ob;
                    // simulate not doing a raw listing when key < params.gte
                    // this represents a key not reaching the read stream from leveldb
                    if (state.params.gte && key < state.params.gte) {
                        return;
                    }

                    if (!key.includes(VID_SEP)) { // master key
                        const version = new Version({ isDeleteMarker });
                        const obj = {
                            key: getListingKey(key, vFormat),
                            value: version.toString(),
                        };

                        const res = delimiter.filter(obj);
                        const skippingRange = delimiter.skipping();
                        handleStreak(res, skippingRange, state);

                        const expected = canSkip ? FILTER_SKIP : FILTER_ACCEPT;
                        assert.strictEqual(res, expected);
                    } else { // versioned key
                        if (vFormat === 'v0') {
                            const vid = key.split(VID_SEP).slice(-1)[0];
                            const version = new Version({ versionId: vid, isDeleteMarker });
                            const obj2 = {
                                key: getListingKey(key, vFormat),
                                value: version.toString(),
                            };
                            const res = delimiter.filter(obj2);
                            const skippingRange = delimiter.skipping();
                            handleStreak(res, skippingRange, state);
                            assert.strictEqual(res, FILTER_SKIP);
                        }
                    }
                });
            });
        });

        it('should return <key><VersionIdSeparator> for DelimiterMaster when ' +
        'NextMarker is set and there is a delimiter', () => {
            const key = 'key';
            const delimiter = new DelimiterMaster({ delimiter: '/', marker: key },
                fakeLogger, vFormat);

            /* Filter a master version to set NextMarker. */
            const listingKey = getListingKey(key, vFormat);
            delimiter.filter({ key: listingKey, value: '' });
            assert.strictEqual(delimiter.NextMarker, key);

            /* With a delimiter skipping should return previous key + VID_SEP
             * (except when a delimiter is set and the NextMarker ends with the
             * delimiter) . */
            assert.strictEqual(delimiter.skipping(), listingKey + VID_SEP);
        });

        it('should return <key><VersionIdSeparator> for DelimiterMaster when ' +
        'NextContinuationToken is set and there is a delimiter', () => {
            const key = 'key';
            const delimiter = new DelimiterMaster(
                { delimiter: '/', startAfter: key, v2: true },
                fakeLogger, vFormat);

            // Filter a master version to set NextContinuationToken
            const listingKey = getListingKey(key, vFormat);
            delimiter.filter({ key: listingKey, value: '' });
            assert.strictEqual(delimiter.NextContinuationToken, key);

            assert.strictEqual(delimiter.skipping(), listingKey + VID_SEP);
        });

        it('should return NextMarker for DelimiterMaster when NextMarker is set' +
        ', there is a delimiter and the key ends with the delimiter', () => {
            const delimiterChar = '/';
            const keyWithEndingDelimiter = `key${delimiterChar}`;
            const delimiter = new DelimiterMaster({
                delimiter: delimiterChar,
                marker: keyWithEndingDelimiter,
            }, fakeLogger, vFormat);

            /* When a delimiter is set and the NextMarker ends with the
             * delimiter it should return the next marker value. */
            assert.strictEqual(delimiter.NextMarker, keyWithEndingDelimiter);
            const skipKey = vFormat === 'v1' ?
                `${DbPrefixes.Master}${keyWithEndingDelimiter}` :
                keyWithEndingDelimiter;
            assert.strictEqual(delimiter.skipping(), skipKey);
        });

        it('should skip entries not starting with prefix', () => {
            const delimiter = new DelimiterMaster({ prefix: 'prefix' }, fakeLogger, vFormat);

            const listingKey = getListingKey('wrong', vFormat);
            assert.strictEqual(delimiter.filter({ key: listingKey }), FILTER_SKIP);
            assert.strictEqual(delimiter.NextMarker, undefined);
            assert.strictEqual(delimiter.prvKey, undefined);
            assert.deepStrictEqual(delimiter.result(), EmptyResult);
        });

        it('should skip entries inferior to next marker', () => {
            const delimiter = new DelimiterMaster({ marker: 'b' }, fakeLogger, vFormat);

            const listingKey = getListingKey('a', vFormat);
            assert.strictEqual(delimiter.filter({ key: listingKey }), FILTER_SKIP);
            assert.strictEqual(delimiter.NextMarker, 'b');
            assert.strictEqual(delimiter.prvKey, undefined);
            assert.deepStrictEqual(delimiter.result(), EmptyResult);
        });

        it('should accept a master version', () => {
            const delimiter = new DelimiterMaster({}, fakeLogger, vFormat);
            const key = 'key';
            const value = '';

            const listingKey = getListingKey(key, vFormat);
            assert.strictEqual(delimiter.filter({ key: listingKey, value }), FILTER_ACCEPT);
            if (vFormat === 'v0') {
                assert.strictEqual(delimiter.prvKey, key);
            }
            assert.strictEqual(delimiter.NextMarker, key);
            assert.deepStrictEqual(delimiter.result(), {
                CommonPrefixes: [],
                Contents: [{ key, value }],
                IsTruncated: false,
                NextMarker: undefined,
                Delimiter: undefined,
            });
        });

        it('should return good values for entries with different common prefixes', () => {
            const delimiterChar = '/';
            const commonPrefix1 = `commonPrefix1${delimiterChar}`;
            const commonPrefix2 = `commonPrefix2${delimiterChar}`;
            const prefix1Key1 = `${commonPrefix1}key1`;
            const prefix1Key2 = `${commonPrefix1}key2`;
            const prefix2Key1 = `${commonPrefix2}key1`;
            const value = 'value';

            const delimiter = new DelimiterMaster({ delimiter: delimiterChar },
                fakeLogger, vFormat);

            /* Filter the first entry with a common prefix. It should be
             * accepted and added to the result. */
            assert.strictEqual(delimiter.filter({
                key: getListingKey(prefix1Key1, vFormat),
                value,
            }),
            FILTER_ACCEPT);
            assert.deepStrictEqual(delimiter.result(), {
                CommonPrefixes: [commonPrefix1],
                Contents: [],
                IsTruncated: false,
                NextMarker: undefined,
                Delimiter: delimiterChar,
            });

            /* Filter the second entry with the same common prefix than the
             * first entry. It should be skipped and not added to the result. */
            assert.strictEqual(delimiter.filter({
                key: getListingKey(prefix1Key2, vFormat),
                value,
            }),
            FILTER_SKIP);
            assert.deepStrictEqual(delimiter.result(), {
                CommonPrefixes: [commonPrefix1],
                Contents: [],
                IsTruncated: false,
                NextMarker: undefined,
                Delimiter: delimiterChar,
            });

            /* Filter an entry with a new common prefix. It should be accepted
             * and not added to the result. */
            assert.strictEqual(delimiter.filter({
                key: getListingKey(prefix2Key1, vFormat),
                value,
            }),
            FILTER_ACCEPT);
            assert.deepStrictEqual(delimiter.result(), {
                CommonPrefixes: [commonPrefix1, commonPrefix2],
                Contents: [],
                IsTruncated: false,
                NextMarker: undefined,
                Delimiter: delimiterChar,
            });
        });

        if (vFormat === 'v0') {
            it('should accept a PHD version as first input', () => {
                const delimiter = new DelimiterMaster({}, fakeLogger, vFormat);
                const keyPHD = 'keyPHD';
                const objPHD = {
                    key: keyPHD,
                    value: Version.generatePHDVersion(generateVersionId('', '')),
                };

                /* When filtered, it should return FILTER_ACCEPT and set the prvKey
                 * to undefined. It should not be added to the result content or common
                 * prefixes. */
                assert.strictEqual(delimiter.filter(objPHD), FILTER_ACCEPT);
                assert.strictEqual(delimiter.prvKey, undefined);
                assert.strictEqual(delimiter.NextMarker, undefined);
                assert.deepStrictEqual(delimiter.result(), EmptyResult);
            });

            it('should accept a PHD version', () => {
                const delimiter = new DelimiterMaster({}, fakeLogger, vFormat);
                const key = 'keyA';
                const value = '';
                const keyPHD = 'keyBPHD';
                const objPHD = {
                    key: keyPHD,
                    value: Version.generatePHDVersion(generateVersionId('', '')),
                };

                /* Filter a master version to set the NextMarker, the prvKey and add
                 * and element in result content. */
                delimiter.filter({ key, value });

                /* When filtered, it should return FILTER_ACCEPT and set the prvKey
                 * to undefined. It should not be added to the result content or common
                 * prefixes. */
                assert.strictEqual(delimiter.filter(objPHD), FILTER_ACCEPT);
                assert.strictEqual(delimiter.prvKey, undefined);
                assert.strictEqual(delimiter.NextMarker, key);
                assert.deepStrictEqual(delimiter.result(), {
                    CommonPrefixes: [],
                    Contents: [{ key, value }],
                    IsTruncated: false,
                    NextMarker: undefined,
                    Delimiter: undefined,
                });
            });

            it('should accept a version after a PHD', () => {
                const delimiter = new DelimiterMaster({}, fakeLogger, vFormat);
                const masterKey = 'key';
                const keyVersion = `${masterKey}${VID_SEP}version`;
                const value = '';
                const objPHD = {
                    key: masterKey,
                    value: Version.generatePHDVersion(generateVersionId('', '')),
                };

                /* Filter the PHD object. */
                delimiter.filter(objPHD);

                /* The filtering of the PHD object has no impact, the version is
                 * accepted and added to the result. */
                assert.strictEqual(delimiter.filter({
                    key: keyVersion,
                    value,
                }), FILTER_ACCEPT);
                assert.strictEqual(delimiter.prvKey, masterKey);
                assert.strictEqual(delimiter.NextMarker, masterKey);
                assert.deepStrictEqual(delimiter.result(), {
                    CommonPrefixes: [],
                    Contents: [{ key: masterKey, value }],
                    IsTruncated: false,
                    NextMarker: undefined,
                    Delimiter: undefined,
                });
            });

            it('should skip a delete marker version', () => {
                const delimiter = new DelimiterMaster({}, fakeLogger, vFormat);
                const version = new Version({ isDeleteMarker: true });
                const key = 'key';
                const obj = {
                    key: `${key}${VID_SEP}version`,
                    value: version.toString(),
                };

                /* When filtered, it should return FILTER_SKIP and set the prvKey. It
                 * should not be added to the result content or common prefixes. */
                assert.strictEqual(delimiter.filter(obj), FILTER_SKIP);
                assert.strictEqual(delimiter.NextMarker, undefined);
                assert.strictEqual(delimiter.prvKey, key);
                assert.deepStrictEqual(delimiter.result(), EmptyResult);
            });

            it('should skip version after a delete marker master', () => {
                const delimiter = new DelimiterMaster({}, fakeLogger, vFormat);
                const version = new Version({ isDeleteMarker: true });
                const key = 'key';
                const versionKey = `${key}${VID_SEP}version`;

                delimiter.filter({ key, value: version.toString() });
                assert.strictEqual(delimiter.filter({
                    key: versionKey,
                    value: 'value',
                }), FILTER_SKIP);
                assert.strictEqual(delimiter.NextMarker, undefined);
                assert.strictEqual(delimiter.prvKey, key);
                assert.deepStrictEqual(delimiter.result(), EmptyResult);
            });

            it('should accept a new master key after a delete marker master', () => {
                const delimiter = new DelimiterMaster({}, fakeLogger, vFormat);
                const version = new Version({ isDeleteMarker: true });
                const key1 = 'key1';
                const key2 = 'key2';
                const value = 'value';

                delimiter.filter({ key: key1, value: version.toString() });
                assert.strictEqual(delimiter.filter({
                    key: key2,
                    value: 'value',
                }), FILTER_ACCEPT);
                assert.strictEqual(delimiter.NextMarker, key2);
                assert.strictEqual(delimiter.prvKey, key2);
                assert.deepStrictEqual(delimiter.result(), {
                    CommonPrefixes: [],
                    Contents: [{ key: key2, value }],
                    IsTruncated: false,
                    NextMarker: undefined,
                    Delimiter: undefined,
                });
            });

            it('should accept the master version and skip the other ones', () => {
                const delimiter = new DelimiterMaster({}, fakeLogger, vFormat);
                const masterKey = 'key';
                const masterValue = 'value';
                const versionKey = `${masterKey}${VID_SEP}version`;
                const versionValue = 'versionvalue';

                /* Filter the master version. */
                delimiter.filter({ key: masterKey, value: masterValue });

                /* Version is skipped, not added to the result. The delimiter
                 * NextMarker and prvKey value are unmodified and set to the
                 * masterKey. */
                assert.strictEqual(delimiter.filter({
                    key: versionKey,
                    value: versionValue,
                }), FILTER_SKIP);
                assert.strictEqual(delimiter.NextMarker, masterKey);
                assert.strictEqual(delimiter.prvKey, masterKey);
                assert.deepStrictEqual(delimiter.result(), {
                    CommonPrefixes: [],
                    Contents: [{ key: masterKey, value: masterValue }],
                    IsTruncated: false,
                    NextMarker: undefined,
                    Delimiter: undefined,
                });
            });

            it('should return good listing result for version', () => {
                const delimiter = new DelimiterMaster({}, fakeLogger, vFormat);
                const masterKey = 'key';
                const versionKey1 = `${masterKey}${VID_SEP}version1`;
                const versionKey2 = `${masterKey}${VID_SEP}version2`;
                const value2 = 'value2';

                /* Filter the PHD version. */
                assert.strictEqual(delimiter.filter({
                    key: masterKey,
                    value: '{ "isPHD": true, "value": "version" }',
                }), FILTER_ACCEPT);

                /* Filter a delete marker version. */
                assert.strictEqual(delimiter.filter({
                    key: versionKey1,
                    value: '{ "isDeleteMarker": true }',
                }), FILTER_ACCEPT);

                /* Filter a last version with a specific value. */
                assert.strictEqual(delimiter.filter({
                    key: versionKey2,
                    value: value2,
                }), FILTER_ACCEPT);

                assert.deepStrictEqual(delimiter.result(), {
                    CommonPrefixes: [],
                    Contents: [{ key: masterKey, value: value2 }],
                    IsTruncated: false,
                    NextMarker: undefined,
                    Delimiter: undefined,
                });
            });

            /* We test here the internal management of the prvKey field of the
             * DelimiterMaster class, in particular once it has been set to an entry
             * key before to finally skip this entry because of an already present
             * common prefix. */
            it('should accept a version after skipping an object because of its commonPrefix', () => {
                const delimiterChar = '/';
                const commonPrefix1 = `commonPrefix1${delimiterChar}`;
                const commonPrefix2 = `commonPrefix2${delimiterChar}`;
                const prefix1Key1 = `${commonPrefix1}key1`;
                const prefix1Key2 = `${commonPrefix1}key2`;
                const prefix2VersionKey1 = `${commonPrefix2}key1${VID_SEP}version`;
                const value = 'value';

                const delimiter = new DelimiterMaster({ delimiter: delimiterChar },
                    fakeLogger, vFormat);

                /* Filter the two first entries with the same common prefix to add
                 * it to the result and reach the state where an entry is skipped
                 * because of an already present common prefix in the result. */
                delimiter.filter({ key: prefix1Key1, value });
                delimiter.filter({ key: prefix1Key2, value });

                /* Filter an object with a key containing a version part and a new
                 * common prefix. It should be accepted and the new common prefix
                 * added to the result. */
                assert.strictEqual(delimiter.filter({
                    key: prefix2VersionKey1,
                    value,
                }), FILTER_ACCEPT);
                assert.deepStrictEqual(delimiter.result(), {
                    CommonPrefixes: [commonPrefix1, commonPrefix2],
                    Contents: [],
                    IsTruncated: false,
                    NextMarker: undefined,
                    Delimiter: delimiterChar,
                });
            });

            it('should skip a versioned entry when there is a delimiter and the key ' +
            'starts with the NextMarker value', () => {
                const delimiterChar = '/';
                const commonPrefix = `commonPrefix${delimiterChar}`;
                const key = `${commonPrefix}key${VID_SEP}version`;
                const value = 'value';

                const delimiter = new DelimiterMaster({ delimiter: delimiterChar },
                    fakeLogger, vFormat);
                /* TODO: should be set to a whole key instead of just a common prefix
                 * once ZENKO-1048 is fixed. */
                delimiter.NextMarker = commonPrefix;

                assert.strictEqual(delimiter.filter({ key, value }), FILTER_SKIP);
            });

            it('should return good skipping value for DelimiterMaster on replay keys', () => {
                const delimiter = new DelimiterMaster(
                    { delimiter: '/', v2: true },
                    fakeLogger, vFormat);

                for (let i = 0; i < 10; i++) {
                    delimiter.filter({
                        key: `foo/${zpad(i)}`,
                        value: '{}',
                    });
                }
                // simulate a listing that goes through a replay key, ...
                assert.strictEqual(
                    delimiter.filter({
                        key: `${DbPrefixes.Replay}xyz`,
                        value: 'abcdef',
                    }),
                    FILTER_SKIP);
                // ...it should skip the whole replay prefix
                assert.strictEqual(delimiter.skipping(), DbPrefixes.Replay);

                // simulate a listing that reaches regular object keys
                // beyond the replay prefix, ...
                assert.strictEqual(
                    delimiter.filter({
                        key: `${inc(DbPrefixes.Replay)}foo/bar`,
                        value: '{}',
                    }),
                    FILTER_ACCEPT);
                // ...it should return to skipping by prefix as usual
                assert.strictEqual(delimiter.skipping(), `${inc(DbPrefixes.Replay)}foo/`);
            });
        }
    });
});
