'use strict';

const DEPARTMENT = 'DEPARTMENT';

function cloneTarget(target) {
    if (!target) return null;
    return {
        type: target.type,
        departmentId: target.departmentId,
        roleId: null,
        workerId: null
    };
}

function parseDepartmentTarget(value, fieldName = 'serviceExecutionTarget') {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw `${fieldName} non valido.`;
    }
    if (value.type !== DEPARTMENT ||
        typeof value.departmentId !== 'string' || !value.departmentId.trim() ||
        (value.roleId !== undefined && value.roleId !== null) ||
        (value.workerId !== undefined && value.workerId !== null)) {
        throw `${fieldName} deve essere un target DEPARTMENT con departmentId canonico.`;
    }
    return {
        type: DEPARTMENT,
        departmentId: value.departmentId.trim(),
        roleId: null,
        workerId: null
    };
}

function effectiveTarget(record, targetField = 'serviceExecutionTarget') {
    const legacyDepartmentId = record && typeof record.serviceDepartmentId === 'string'
        ? record.serviceDepartmentId.trim() : '';
    const hasTypedField = !!record && Object.prototype.hasOwnProperty.call(record, targetField);
    if (hasTypedField && record[targetField] === null) return null;
    try {
        if (hasTypedField && record[targetField] !== undefined) {
            const typed = parseDepartmentTarget(record[targetField], targetField);
            if (legacyDepartmentId && typed.departmentId !== legacyDepartmentId) return null;
            return typed;
        }
    } catch (_) {
        return null;
    }
    return legacyDepartmentId ? {
        type: DEPARTMENT,
        departmentId: legacyDepartmentId,
        roleId: null,
        workerId: null
    } : null;
}

function normalizeWrite(body, existing, options = {}) {
    const targetField = options.targetField || 'serviceExecutionTarget';
    const versionField = options.versionField || 'serviceExecutionTargetVersion';
    const publishField = options.publishField || 'publishToService';
    const hasTarget = body[targetField] !== undefined;
    const hasVersion = body[versionField] !== undefined;
    const hasLegacyDepartment = body.serviceDepartmentId !== undefined;
    const hasPublish = body[publishField] !== undefined;
    const currentTarget = effectiveTarget(existing, targetField);
    const currentVersion = Number(existing && existing[versionField] || 0);

    if (hasVersion &&
        (typeof body[versionField] !== 'number' ||
         !Number.isInteger(body[versionField]) || body[versionField] < 0)) {
        throw new Error(`${versionField} non valido.`);
    }
    if (existing && (hasTarget || hasVersion)) {
        const expected = body[versionField];
        if (!hasVersion || expected !== currentVersion) {
            const error = new Error('La destinazione Service è stata modificata. Ricarica e riprova.');
            error.code = 'SERVICE_TARGET_VERSION_CONFLICT';
            error.status = 409;
            error.version = currentVersion;
            throw error;
        }
    }

    const typedTarget = hasTarget ? parseDepartmentTarget(body[targetField], targetField) : null;
    const legacyId = hasLegacyDepartment
        ? (body.serviceDepartmentId ? String(body.serviceDepartmentId).trim() : null)
        : undefined;
    if (hasTarget && hasLegacyDepartment &&
        ((typedTarget && typedTarget.departmentId) || null) !== (legacyId || null)) {
        throw 'Le rappresentazioni della destinazione Service non corrispondono.';
    }

    let target = hasTarget ? typedTarget
        : hasLegacyDepartment ? (legacyId ? {
            type: DEPARTMENT, departmentId: legacyId, roleId: null, workerId: null
        } : null)
        : currentTarget;
    target = cloneTarget(target);
    const currentPublish = existing && existing[publishField] === true;
    let publish = hasPublish ? body[publishField] === true : currentPublish;
    if (!target) publish = false;

    const targetChanged = JSON.stringify(target) !== JSON.stringify(currentTarget);
    const publishChanged = publish !== currentPublish;
    return {
        target,
        publish,
        version: existing ? currentVersion + (targetChanged || publishChanged ? 1 : 0) : 0,
        targetChanged,
        publishChanged,
        serviceStateChanged: targetChanged || publishChanged,
        fieldsPresent: hasTarget || hasLegacyDepartment || hasPublish || hasVersion
    };
}

module.exports = {
    DEPARTMENT,
    effectiveTarget,
    normalizeWrite,
    parseDepartmentTarget
};