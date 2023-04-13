import * as fs from 'fs';
import path from 'path';
import glob from 'glob';
import frontmatter from 'front-matter';
import { allModels } from '.stackbit/models';
import { Config } from '.stackbit/models/Config';
import { isDev, objectIdAttr, fieldPathAttr } from './common';

const pagesDir = 'content/pages';
const dataDir = 'content/data';

const allReferenceFields = {};
allModels.forEach((model) => {
    model.fields.forEach((field) => {
        if (field.type === 'reference' || (field.type === 'list' && field.items?.type === 'reference')) {
            allReferenceFields[model.name + ':' + field.name] = true;
        }
    });
});

function isRefField(modelName: string, fieldName: string) {
    return !!allReferenceFields[modelName + ':' + fieldName];
}

const supportedFileTypes = ['md', 'json'];
function contentFilesInPath(dir: string) {
    const globPattern = `${dir}/**/*.{${supportedFileTypes.join(',')}}`;
    return glob.sync(globPattern);
}

function readContent(file: string) {
    const rawContent = fs.readFileSync(file, 'utf8');
    let content = null;
    switch (path.extname(file).substring(1)) {
        case 'md':
            const parsedMd = frontmatter<Record<string, any>>(rawContent);
            content = {
                ...parsedMd.attributes,
                markdown_content: parsedMd.body
            };
            break;
        case 'json':
            content = JSON.parse(rawContent);
            break;
        default:
            throw Error(`Unhandled file type: ${file}`);
    }

    // Make Sourcebit-compatible
    content.__metadata = {
        id: file,
        modelName: content.type
    };

    return content;
}

function resolveReferences(content, fileToContent) {
    if (!content || !content.type) return;

    const modelName = content.type;
    // Make Sourcebit-compatible
    if (!content.__metadata) content.__metadata = { modelName };

    for (const fieldName in content) {
        let fieldValue = content[fieldName];
        if (!fieldValue) continue;

        const isRef = isRefField(modelName, fieldName);
        if (Array.isArray(fieldValue)) {
            if (fieldValue.length === 0) continue;
            if (isRef && typeof fieldValue[0] === 'string') {
                fieldValue = fieldValue.map((filename) => fileToContent[filename]);
                content[fieldName] = fieldValue;
            }
            if (typeof fieldValue[0] === 'object') {
                fieldValue.forEach((o) => resolveReferences(o, fileToContent));
            }
        } else {
            if (isRef && typeof fieldValue === 'string') {
                fieldValue = fileToContent[fieldValue];
                content[fieldName] = fieldValue;
            }
            if (typeof fieldValue === 'object') {
                resolveReferences(fieldValue, fileToContent);
            }
        }
    }
}

function fileToUrl(file: string) {
    if (!file.startsWith(pagesDir)) return;

    let url = file.slice(pagesDir.length);
    url = url.split('.')[0];
    if (url.endsWith('/index')) {
        url = url.slice(0, -6) || '/';
    }
    return url;
}

export function allContent() {
    let objects = [dataDir, pagesDir].flatMap((dir) => {
        return contentFilesInPath(dir).map((file) => readContent(file));
    });
    objects.forEach((o) => {
        o.__metadata.urlPath = fileToUrl(o.__metadata.id);
    });

    const fileToContent = Object.fromEntries(objects.map((e) => [e.__metadata.id, e]));
    objects.forEach((e) => resolveReferences(e, fileToContent));

    objects = objects.map((e) => deepClone(e));
    objects.forEach((e) => annotateContentObject(e));

    const pages = objects.filter((o) => !!o.__metadata.urlPath);
    const siteConfig = objects.find((e) => e.__metadata.modelName === Config.name);
    return { objects, pages, props: { site: siteConfig } };
}

/*
Add annotation data to a content object and its nested children.
*/
const skipList = ['__metadata'];
const logAnnotations = false;

function annotateContentObject(o, prefix = '', depth = 0) {
    if (!isDev || !o || typeof o !== 'object' || !o.type || skipList.includes(prefix)) return;

    const depthPrefix = '--'.repeat(depth);
    if (depth === 0) {
        if (o.__metadata?.id) {
            o[objectIdAttr] = o.__metadata.id;
            if (logAnnotations) console.log('[annotateContentObject] added object ID:', depthPrefix, o[objectIdAttr]);
        } else {
            if (logAnnotations) console.warn('[annotateContentObject] NO object ID:', o);
        }
    } else {
        o[fieldPathAttr] = prefix;
        if (logAnnotations) console.log('[annotateContentObject] added field path:', depthPrefix, o[fieldPathAttr]);
    }

    Object.entries(o).forEach(([k, v]) => {
        if (v && typeof v === 'object') {
            const fieldPrefix = (prefix ? prefix + '.' : '') + k;
            if (Array.isArray(v)) {
                v.forEach((e, idx) => {
                    const elementPrefix = fieldPrefix + '.' + idx;
                    annotateContentObject(e, elementPrefix, depth + 1);
                });
            } else {
                annotateContentObject(v, fieldPrefix, depth + 1);
            }
        }
    });
}

function deepClone(o: object) {
    return JSON.parse(JSON.stringify(o));
}
